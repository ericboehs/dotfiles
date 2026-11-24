# frozen_string_literal: true

# Tests for bin/gh-watch. Run: ruby test/gh-watch_test.rb
#
# The script runs as a subprocess against a TCPServer fake of the GitHub REST
# and GraphQL APIs (GHWATCH_TEST_API_BASE, loopback only), with a fake `gh` on
# PATH for the token and GHWATCH_TEST_NOW for the clock.

require 'minitest/autorun'
require 'json'
require 'open3'
require 'socket'
require 'tmpdir'
require 'fileutils'
require 'time'

SCRIPT = File.expand_path('../bin/gh-watch', __dir__)
load SCRIPT

NOW = Time.utc(2026, 11, 19, 12, 0, 0)
TOKEN = 'test-token-abc123' # what the fake `gh auth token` prints
FAKE_TOKEN = 'ghwatch-test-token' # what gh-watch sends to a test API base
SHA_A = 'a' * 40
SHA_B = 'b' * 40

def ago(seconds)
  (NOW - seconds).utc.iso8601
end

# A tiny HTTP/1.1 server: one request per connection, routed by a block.
class FakeGitHub
  Request = Struct.new(:http_method, :target, :headers, :body, keyword_init: true) do
    def path
      target.split('?').first
    end

    def json
      JSON.parse(body)
    end
  end

  attr_reader :requests, :port

  def initialize(&router)
    @router = router
    @requests = []
    @server = TCPServer.new('127.0.0.1', 0)
    @port = @server.addr[1]
    @thread = Thread.new { loop { handle(@server.accept) } }
  end

  def base
    "http://127.0.0.1:#{@port}"
  end

  def stop
    @thread.kill
    @server.close
  end

  def graphql_requests
    @requests.select { |r| r.path == '/graphql' }
  end

  def main_queries
    graphql_requests.select { |r| r.json['query'].include?('closed: pullRequests') }
  end

  def detail_queries
    graphql_requests.select { |r| r.json['query'].include?('p0: pullRequest(') }
  end

  private

  def handle(sock)
    line = sock.gets or return
    method, target, = line.split
    headers = {}
    while (h = sock.gets) && h != "\r\n"
      k, v = h.split(':', 2)
      headers[k.strip.downcase] = v.strip
    end
    body = headers['content-length'] ? sock.read(headers['content-length'].to_i) : ''
    req = Request.new(http_method: method, target: target, headers: headers, body: body)
    @requests << req
    status, extra, payload = @router.call(req)
    payload = payload.is_a?(String) ? payload : JSON.generate(payload)
    head = ["HTTP/1.1 #{status} X", 'Content-Type: application/json', "Content-Length: #{payload.bytesize}",
            'Connection: close']
    (extra || {}).each { |k, v| head << "#{k}: #{v}" }
    sock.write("#{head.join("\r\n")}\r\n\r\n#{payload}")
  rescue StandardError => e
    warn "fake server: #{e.class}: #{e.message}"
  ensure
    sock&.close
  end
end

module Fixtures
  module_function

  def author(login, type = 'User')
    login && { '__typename' => type, 'login' => login }
  end

  def conn(nodes, more: false)
    { 'pageInfo' => { 'hasPreviousPage' => more, 'startCursor' => more ? 'CUR' : nil }, 'nodes' => nodes }
  end

  def pr(number:, author: 'alice', head: SHA_A, rollup: nil, created: ago(86_400), updated: ago(30),
         head_author: 'alice', committed: ago(86_400), comments: [], reviews: [], threads: [], base: 'main',
         author_type: 'User', comments_more: false)
    {
      'number' => number, 'title' => "PR #{number}\ttitle", 'createdAt' => created, 'updatedAt' => updated,
      'baseRefName' => base, 'headRefOid' => head, 'author' => author(author, author_type),
      'commits' => { 'nodes' => [{ 'commit' => {
        'oid' => head, 'committedDate' => committed,
        'author' => { 'user' => head_author && { 'login' => head_author } },
        'statusCheckRollup' => rollup && { 'state' => rollup }
      } }] },
      'reviews' => conn(reviews), 'comments' => conn(comments, more: comments_more), 'reviewThreads' => conn(threads)
    }
  end

  def comment(id, who, at, body = 'hello', type: 'User')
    { 'databaseId' => id.to_i, 'fullDatabaseId' => id.to_s, 'author' => author(who, type), 'createdAt' => at,
      'body' => body }
  end

  def review(id, who, state, at, body = '')
    { 'databaseId' => id.to_i, 'fullDatabaseId' => id.to_s, 'state' => state, 'author' => author(who),
      'submittedAt' => at, 'body' => body }
  end

  def thread(*comments)
    { 'id' => 'T_1', 'comments' => conn(comments) }
  end

  def inline(id, who, at, path, body, review: nil)
    comment(id, who, at, body).merge('path' => path, 'pullRequestReview' => review && { 'databaseId' => review })
  end

  def closed(number:, state:, closed_at:, by: 'bob', updated: closed_at)
    { 'number' => number, 'title' => "Closed #{number}", 'state' => state, 'closedAt' => closed_at,
      'mergedAt' => state == 'MERGED' ? closed_at : nil, 'updatedAt' => updated, 'baseRefName' => 'main',
      'author' => author('alice'), 'mergedBy' => state == 'MERGED' ? author(by) : nil,
      'timelineItems' => { 'nodes' => state == 'MERGED' ? [] : [{ 'actor' => author(by) }] } }
  end

  def graphql(open: [], closed: [])
    { 'data' => {
      'repository' => {
        'open' => { 'pageInfo' => { 'hasNextPage' => false, 'endCursor' => nil }, 'nodes' => open },
        'closed' => { 'pageInfo' => { 'hasNextPage' => false, 'endCursor' => nil }, 'nodes' => closed }
      },
      'rateLimit' => { 'cost' => 3, 'remaining' => 4997, 'limit' => 5000, 'resetAt' => ago(-3600) }
    } }
  end
end

class GhWatchTest < Minitest::Test
  include Fixtures

  def setup
    @tmp = Dir.mktmpdir('gh-watch-test')
    @state_dir = File.join(@tmp, 'state')
    FileUtils.mkdir_p(@state_dir)
    @bin = File.join(@tmp, 'bin')
    FileUtils.mkdir_p(@bin)
    @gh_log = File.join(@tmp, 'gh.log')
    File.write(File.join(@bin, 'gh'), <<~SH)
      #!/bin/sh
      echo "$* ent=${GH_ENTERPRISE_TOKEN:-}" >> #{@gh_log}
      if [ "$1 $2 $3" = "auth status --hostname" ]; then
        case "$4" in github.com|ghe.example.com) exit 0 ;; esac
      fi
      if [ "$1 $2 $3" = "auth token --hostname" ]; then
        if [ "$4" = "github.com" ]; then echo #{TOKEN}; exit 0; fi
        if [ "$4" = "ghe.example.com" ] && [ -n "${GH_ENTERPRISE_TOKEN:-}" ]; then echo "$GH_ENTERPRISE_TOKEN"; exit 0; fi
      fi
      echo "not logged in" >&2; exit 1
    SH
    File.chmod(0o755, File.join(@bin, 'gh'))
    @etag = 'W/"e1"'
    @gql = graphql
    @routes = {}
  end

  def teardown
    @server&.stop
    FileUtils.rm_rf(@tmp)
  end

  def server
    @server ||= FakeGitHub.new do |req|
      custom = @routes.find { |pattern, _| req.target.match?(pattern) || "#{req.http_method} #{req.path}" == pattern }
      if custom
        custom[1].call(req)
      elsif req.path == '/repos/acme/widgets/pulls'
        req.headers['if-none-match'] == @etag ? [304, {}, ''] : [200, { 'ETag' => @etag }, [{ 'number' => 1 }]]
      elsif req.path == '/repos/acme/widgets/issues' && req.target.match?(/per_page=1(&|\z)/)
        [200, { 'ETag' => 'W/"i1"' }, []]
      elsif req.path == '/graphql'
        [200, {}, req.json['query'].include?('p0: pullRequest(') ? details_for(req) : @gql]
      elsif req.path == '/user'
        [200, {}, { 'login' => 'octocat' }]
      else
        [404, {}, { 'message' => 'Not Found' }]
      end
    end
  end

  # The nested reviews/comments query, answered from the open PRs in @gql.
  def details_for(req)
    open = @gql.dig('data', 'repository', 'open', 'nodes')
    repo = {}
    req.json['variables'].each do |k, v|
      next unless (m = k.match(/\An(\d+)\z/))

      node = open.find { |p| p['number'] == v }
      repo["p#{m[1]}"] = node&.slice('number', 'reviews', 'comments', 'reviewThreads')
    end
    { 'data' => { 'repository' => repo, 'rateLimit' => { 'cost' => 1, 'remaining' => 4996 } } }
  end

  def write_state(state)
    File.write(File.join(@state_dir, 'state.json'), JSON.generate(state))
  end

  def base_state(extra = {})
    { 'version' => 1, 'host' => 'github.com', 'repo' => 'acme/widgets', 'since' => ago(300),
      'last_full' => ago(120), 'etag' => 'W/"old"', 'me' => 'octocat', 'prs' => {} }.merge(extra)
  end

  def run_watch(*args, env: {})
    full_env = {
      'PATH' => "#{@bin}:#{ENV.fetch('PATH')}", 'GHWATCH_TEST_API_BASE' => server.base, 'GHWATCH_TEST_NOW' => NOW.iso8601,
      'WATCHER_STATE_DIR' => @state_dir, 'WATCHER_REPO' => 'acme/widgets', 'WATCHER_HOST' => 'github.com',
      'WATCHER_ME' => 'octocat', 'WATCHER_CWD' => nil, 'GH_TOKEN' => nil, 'GITHUB_TOKEN' => nil,
      'GH_ENTERPRISE_TOKEN' => nil, 'GITHUB_ENTERPRISE_TOKEN' => nil, 'GHWATCH_TEST_TOKEN' => nil
    }.merge(env)
    args = ['--jsonl'] if args.empty?
    out, err, st = Open3.capture3(full_env, RbConfig.ruby, SCRIPT, *args)
    @err = err
    @status = st.exitstatus
    @out = out
    args.include?('--jsonl') ? out.lines.map { |l| JSON.parse(l) } : []
  end

  def next_state
    JSON.parse(File.read(File.join(@state_dir, 'state.json.next')))
  end

  def by_id(events)
    events.to_h { |e| [e['id'], e] }
  end

  # ---- first sight, change check, refresh ------------------------------

  def test_first_sight_records_heads_and_emits_nothing_old
    @gql = graphql(open: [pr(number: 5, rollup: 'FAILURE', author: 'octocat'),
                          pr(number: 6, created: ago(600), author: 'bob')])
    events = run_watch
    assert_equal 0, @status, @err
    assert_equal(['gh:opened:6'], events.map { |e| e['id'] })
    assert_equal 'info', events.first['kind']
    st = next_state
    assert_equal SHA_A, st['prs']['5']['head']
    assert_equal 'failure', st['prs']['5']['ci']
    assert_equal NOW.iso8601, st['since']
    assert_equal 'octocat', st['me']
    assert_equal "Bearer #{FAKE_TOKEN}", server.requests.first.headers['authorization']
  end

  def test_304_skips_graphql_and_holds_since
    write_state(base_state('etag' => @etag))
    assert_empty run_watch
    assert_equal 0, @status, @err
    assert_empty server.graphql_requests
    assert_equal ago(300), next_state['since'], 'no query read anything'
    assert_equal ago(120), next_state['last_full']
  end

  def test_200_runs_graphql
    write_state(base_state)
    run_watch
    assert_equal 1, server.graphql_requests.size
    assert_equal @etag, next_state['etag']
    assert_equal NOW.iso8601, next_state['since']
    assert_equal ago(120), next_state['last_full'], 'last_full marks the five-minute refresh only'
  end

  def test_pending_ci_bypasses_304
    write_state(base_state('etag' => @etag,
                           'prs' => { '5' => { 'head' => SHA_A, 'ci' => 'pending', 'head_at' => ago(200) } }))
    @gql = graphql(open: [pr(number: 5, rollup: 'SUCCESS')])
    events = run_watch
    assert_equal 1, server.main_queries.size
    assert_equal(["gh:ci:5:#{SHA_A[0, 12]}:success"], events.map { |e| e['id'] })
  end

  def test_five_minute_full_refresh
    write_state(base_state('etag' => @etag, 'last_full' => ago(301)))
    run_watch
    assert_equal 1, server.graphql_requests.size
  end

  def test_null_rollup_on_young_head_is_pending
    write_state(base_state('prs' => { '5' => { 'head' => SHA_A, 'ci' => 'none', 'head_at' => ago(9000) } }))
    @gql = graphql(open: [pr(number: 5, head: SHA_B, head_author: 'alice')])
    run_watch
    assert_equal 'pending', next_state['prs']['5']['ci']
    @gql = graphql(open: [pr(number: 7, committed: ago(3600))])
    write_state(base_state)
    run_watch
    assert_equal 'none', next_state['prs']['7']['ci']
  end

  def test_host_or_repo_change_starts_over
    write_state(base_state('repo' => 'acme/other', 'etag' => @etag,
                           'prs' => { '5' => { 'head' => SHA_B, 'ci' => 'success' } }))
    @gql = graphql(open: [pr(number: 5)])
    assert_empty run_watch # first sight again: no PUSH for the changed head
    assert_equal 1, server.main_queries.size
    assert_equal 'acme/widgets', next_state['repo']
  end

  # ---- verbs and act rules ---------------------------------------------

  def test_push_ci_and_own_push
    prs = { '5' => { 'head' => SHA_A, 'ci' => 'pending', 'head_at' => ago(900) },
            '6' => { 'head' => SHA_A, 'ci' => 'none', 'head_at' => ago(900) },
            '7' => { 'head' => SHA_A, 'ci' => 'none', 'head_at' => ago(900) } }
    write_state(base_state('prs' => prs))
    @gql = graphql(open: [
                     pr(number: 5, author: 'octocat', rollup: 'ERROR'),
                     pr(number: 6, head: SHA_B, head_author: 'octocat', rollup: 'SUCCESS'),
                     pr(number: 7, head: SHA_B, head_author: nil, rollup: 'PENDING')
                   ])
    ev = by_id(run_watch)
    sha = SHA_B[0, 12]
    ci5 = ev.fetch("gh:ci:5:#{SHA_A[0, 12]}:failure")
    assert_equal %w[act CI failure octocat], ci5.values_at('kind', 'verb', 'state', 'actor'),
                 'CI on my PR wakes me even though I am its actor'
    assert_equal 'https://github.com/acme/widgets/pull/5/checks', ci5['url']
    refute ev.key?("gh:push:6:#{sha}"), 'own push is skipped'
    assert_equal 'info', ev.fetch("gh:ci:6:#{sha}:success")['kind']
    push7 = ev.fetch("gh:push:7:#{sha}")
    assert_equal %w[unknown PUSH info], push7.values_at('actor', 'verb', 'kind')
    assert_equal "https://github.com/acme/widgets/commit/#{SHA_B}", push7['url']
    assert_equal 'PR 7 title', push7['title']
    refute ev.keys.any? { |k| k.start_with?('gh:ci:7') }, 'pending CI is suppressed'
    assert_equal 'pending', next_state['prs']['7']['ci']
  end

  def test_ci_unchanged_is_quiet
    write_state(base_state('prs' => { '5' => { 'head' => SHA_A, 'ci' => 'failure', 'head_at' => ago(900) } }))
    @gql = graphql(open: [pr(number: 5, rollup: 'FAILURE', author: 'octocat')])
    assert_empty run_watch
  end

  def test_reviews_and_comments
    write_state(base_state('prs' => { '5' => { 'head' => SHA_A, 'ci' => 'none' },
                                      '6' => { 'head' => SHA_A, 'ci' => 'none' } }))
    mine = pr(number: 5, author: 'octocat',
              reviews: [review(101, 'alice', 'CHANGES_REQUESTED', ago(60), 'please fix'),
                        review(102, 'bob', 'COMMENTED', ago(50)),
                        review(103, 'carol', 'APPROVED', ago(40), 'lgtm'),
                        review(104, 'octocat', 'COMMENTED', ago(40)),
                        review(105, 'dave', 'PENDING', ago(40)),
                        review(99, 'erin', 'APPROVED', ago(4000))],
              comments: [comment(201, 'alice', ago(30), "multi\n\nline   body"),
                         comment(202, 'bob', ago(20), nil),
                         comment(203, 'dependabot', ago(20), 'bump', type: 'Bot'),
                         comment(204, nil, ago(20), 'ghost')],
              threads: [thread(inline(301, 'alice', ago(10), 'lib/a.rb', "nit:\tspace"),
                               inline(302, 'bob', ago(9), 'lib/b.rb', ''))])
    theirs = pr(number: 6, author: 'bob',
                reviews: [review(111, 'alice', 'CHANGES_REQUESTED', ago(60)), review(112, 'alice', 'COMMENTED', ago(55))],
                comments: [comment(211, 'alice', ago(30))])
    @gql = graphql(open: [mine, theirs])
    ev = by_id(run_watch)
    assert_equal 0, @status, @err

    assert_equal %w[act REVIEW CHANGES_REQUESTED alice please\ fix], ev['gh:review:101'].values_at('kind', 'verb', 'state', 'actor', 'untrusted')
    assert_equal 'https://github.com/acme/widgets/pull/5#pullrequestreview-101', ev['gh:review:101']['url']
    assert_equal 'act', ev['gh:review:102']['kind']
    refute ev['gh:review:102'].key?('untrusted'), 'empty body omits untrusted'
    assert_equal 'info', ev['gh:review:103']['kind']
    assert_equal 'info', ev['gh:review:104']['kind'], 'my own review'
    refute ev.key?('gh:review:105'), 'PENDING reviews are skipped'
    refute ev.key?('gh:review:99'), 'older than since - overlap'

    c = ev['gh:comment:201']
    assert_equal %w[act COMMENT conversation multi\ line\ body], c.values_at('kind', 'verb', 'state', 'untrusted')
    assert_equal 'https://github.com/acme/widgets/pull/5#issuecomment-201', c['url']
    refute ev['gh:comment:202'].key?('untrusted'), 'null body omits untrusted'
    assert_equal %w[dependabot[bot] info], ev['gh:comment:203'].values_at('actor', 'kind')
    assert_equal %w[unknown info], ev['gh:comment:204'].values_at('actor', 'kind')

    i = ev['gh:inline:301']
    assert_equal ['act', 'inline', 'lib/a.rb: nit: space'], i.values_at('kind', 'state', 'untrusted')
    assert_equal 'https://github.com/acme/widgets/pull/5#discussion_r301', i['url']
    refute ev['gh:inline:302'].key?('untrusted')

    assert_equal 'act', ev['gh:review:111']['kind'], 'changes requested on any PR'
    assert_equal 'info', ev['gh:review:112']['kind'], 'COMMENTED on a PR that is not mine'
    assert_equal 'info', ev['gh:comment:211']['kind']
  end

  def test_act_on_none_and_no_wake_override
    write_state(base_state('prs' => { '5' => { 'head' => SHA_A, 'ci' => 'none' } }))
    @gql = graphql(open: [pr(number: 5, author: 'octocat',
                             reviews: [review(101, 'alice', 'CHANGES_REQUESTED', ago(60))],
                             comments: [comment(203, 'dependabot', ago(20), 'bump', type: 'Bot')])])
    assert_equal(%w[info info], run_watch('--jsonl', '--act-on', 'none').map { |e| e['kind'] })
    ev = by_id(run_watch('--jsonl', '--no-wake-actors', 'alice'))
    assert_equal 0, @status, @err
    assert_equal 'info', ev['gh:review:101']['kind']
    assert_equal 'act', ev['gh:comment:203']['kind'], 'dependabot wakes once removed from the list'
  end

  def test_team_pr_from_wake_authors_and_wake_team
    write_state(base_state)
    @gql = graphql(open: [pr(number: 8, author: 'alice', created: ago(100)),
                          pr(number: 9, author: 'zed', created: ago(100)),
                          pr(number: 10, author: 'dependabot', author_type: 'Bot', created: ago(100))])
    ev = by_id(run_watch('--jsonl', '--wake-authors', 'Alice'))
    assert_equal(%w[act info info], %w[8 9 10].map { |n| ev["gh:opened:#{n}"]['kind'] })
    assert_equal 'dependabot[bot]', ev['gh:opened:10']['actor']

    @routes['GET /orgs/acme/teams/core/members'] = ->(_) { [200, {}, [{ 'login' => 'zed' }]] }
    write_state(base_state)
    ev = by_id(run_watch('--jsonl', '--wake-team', 'acme/core'))
    assert_equal 'act', ev['gh:opened:9']['kind']
    team = next_state['team']
    assert_equal ['zed'], team['members']
    # Cached for 24 h: no second members call.
    write_state(base_state('team' => team))
    before = server.requests.count { |r| r.path.start_with?('/orgs/') }
    run_watch('--jsonl', '--wake-team', 'acme/core')
    assert_equal(before, server.requests.count { |r| r.path.start_with?('/orgs/') })
  end

  def test_merged_and_closed
    write_state(base_state)
    @gql = graphql(closed: [closed(number: 3, state: 'MERGED', closed_at: '2026-11-19T11:58:07Z'),
                            closed(number: 4, state: 'CLOSED', closed_at: '2026-11-19T11:57:00Z', by: 'carol'),
                            closed(number: 2, state: 'CLOSED', closed_at: ago(7200))])
    ev = by_id(run_watch)
    m = ev.fetch('gh:merged:3:20261119115807')
    assert_equal %w[MERGED merged bob], m.values_at('verb', 'state', 'actor')
    c = ev.fetch('gh:closed:4:20261119115700')
    assert_equal %w[CLOSED closed carol], c.values_at('verb', 'state', 'actor')
    assert_equal 2, ev.size
  end

  def test_paging_back_a_truncated_connection
    write_state(base_state('prs' => { '5' => { 'head' => SHA_A, 'ci' => 'none' } }))
    @gql = graphql(open: [pr(number: 5, comments: [comment(202, 'bob', ago(20))], comments_more: true)])
    @routes[%r{\A/graphql}] = lambda do |req|
      if req.json['query'].include?('pullRequest(number: $number)')
        assert_equal 'CUR', req.json['variables']['before']
        [200, {}, { 'data' => { 'repository' => { 'pullRequest' => { 'comments' => conn([comment(201, 'alice', ago(40))]) } },
                                'rateLimit' => { 'cost' => 1, 'remaining' => 1 } } }]
      elsif req.json['query'].include?('p0: pullRequest(')
        [200, {}, details_for(req)]
      else
        [200, {}, @gql]
      end
    end
    assert_equal(%w[gh:comment:201 gh:comment:202], run_watch.map { |e| e['id'] })
  end

  def test_event_cap_holds_since_at_first_unemitted
    write_state(base_state)
    @gql = graphql(open: (1..205).map { |n| pr(number: n, created: ago(250 - n)) })
    events = run_watch
    assert_equal 200, events.size
    assert_equal 'gh:opened:200', events.last['id']
    assert_equal ago(250 - 201), next_state['since']
  end

  def test_base_branch_filter
    write_state(base_state)
    @gql = graphql(open: [pr(number: 8, created: ago(10), base: 'main'), pr(number: 9, created: ago(10), base: 'dev')])
    assert_equal(['gh:opened:9'], run_watch('--jsonl', '--base', 'dev').map { |e| e['id'] })
  end

  # ---- issues -----------------------------------------------------------

  def test_issue_opened_vs_old_issue_new_comment
    write_state(base_state('etag' => @etag))
    @routes[/issues\?state=all&sort=updated&direction=asc/] = lambda do |_|
      [200, {}, [
        { 'number' => 40, 'title' => 'New bug', 'created_at' => ago(60), 'state' => 'open', 'user' => { 'login' => 'alice' } },
        { 'number' => 41, 'title' => 'Old bug', 'created_at' => ago(90_000), 'state' => 'open', 'user' => { 'login' => 'bob' } },
        { 'number' => 42, 'title' => 'A PR', 'created_at' => ago(60), 'state' => 'open', 'pull_request' => {},
          'user' => { 'login' => 'bob' } },
        { 'number' => 43, 'title' => 'Done', 'created_at' => ago(90_000), 'state' => 'closed', 'closed_at' => '2026-11-19T11:59:00Z',
          'user' => { 'login' => 'bob' } }
      ]]
    end
    @routes[%r{issues/comments\?}] = lambda do |_|
      [200, {}, [{ 'id' => 501, 'created_at' => ago(30), 'body' => 'still broken', 'user' => { 'login' => 'erin' },
                   'html_url' => 'https://github.com/acme/widgets/issues/41#issuecomment-501' },
                 { 'id' => 502, 'created_at' => ago(9000), 'body' => 'edited old', 'user' => { 'login' => 'erin' },
                   'html_url' => 'https://github.com/acme/widgets/issues/41#issuecomment-502' }]]
    end
    ev = by_id(run_watch('--jsonl', '--issues', 'on'))
    assert_equal %w[gh:closed:43:20261119115900 gh:comment:501 gh:opened:40], ev.keys.sort
    assert_equal %w[issue:40 OPENED open], ev['gh:opened:40'].values_at('subject', 'verb', 'state')
    assert_equal 'https://github.com/acme/widgets/issues/40', ev['gh:opened:40']['url']
    assert_equal %w[issue:41 conversation still\ broken], ev['gh:comment:501'].values_at('subject', 'state', 'untrusted')
    assert_equal 'unknown', ev['gh:closed:43:20261119115900']['actor'], 'issue lists have no closed_by'
    assert_equal 'W/"i1"', next_state['issues_etag']
    assert_empty server.graphql_requests, 'PR etag 304 and nothing pending'
  end

  # ---- errors -------------------------------------------------------------

  def test_graphql_http_error_exits_2_without_next
    write_state(base_state)
    @routes['POST /graphql'] = ->(_) { [502, {}, { 'message' => 'Bad Gateway' }] }
    assert_empty run_watch
    assert_equal 2, @status
    assert_equal "gh-watch: POST /graphql -> 502 Bad Gateway\n", @err
    refute File.exist?(File.join(@state_dir, 'state.json.next'))
    assert_empty Dir.children(@state_dir) - ['state.json']
  end

  def test_rest_403_and_graphql_errors
    @routes['GET /repos/acme/widgets/pulls'] = ->(_) { [403, {}, { 'message' => 'API rate limit exceeded' }] }
    run_watch
    assert_equal 2, @status
    assert_equal "gh-watch: GET /repos/acme/widgets/pulls -> 403 API rate limit exceeded\n", @err
    refute_includes @err, TOKEN

    @routes.clear
    @routes['POST /graphql'] = ->(_) { [200, {}, { 'errors' => [{ 'message' => 'Something broke' }] }] }
    run_watch
    assert_equal 2, @status
    assert_match %r{\Agh-watch: POST /graphql -> 200 graphql: Something broke\n\z}, @err
    refute File.exist?(File.join(@state_dir, 'state.json.next'))
  end

  def test_dry_run_writes_nothing_and_exits_0
    @gql = graphql(open: [pr(number: 6, created: ago(10))])
    assert_equal 1, run_watch(env: { 'WATCHER_DRY_RUN' => '1' }).size
    assert_equal 0, @status
    refute File.exist?(File.join(@state_dir, 'state.json.next'))
  end

  def test_argument_errors
    run_watch('--jsonl', '--repo', 'acme/widgets', '--repo', 'acme/other')
    assert_equal [2, "gh-watch: --jsonl watches exactly one repo\n"], [@status, @err]
    run_watch('--jsonl', '--url-host', 'example.com')
    assert_equal 2, @status
    run_watch('--jsonl', '--repo', 'acme/../x;rm')
    assert_equal 2, @status
    run_watch(env: { 'WATCHER_STATE_DIR' => nil })
    assert_equal [2, "gh-watch: WATCHER_STATE_DIR is required with --jsonl\n"], [@status, @err]
    token_for('example.com')
    assert_match(/no gh auth for example\.com/, @err)
  end

  def test_dot_names_are_rejected
    ['../..', 'acme/..', './widgets', 'acme/...'].each do |repo|
      run_watch('--jsonl', '--repo', repo)
      assert_equal 2, @status, repo
      assert_match(/bad repo/, @err, repo)
    end
    run_watch('--once', '--text', '--state-dir', @state_dir, '--repo', 'acme/widgets', '--repo', '../..')
    assert_equal 2, @status
    assert_empty server.requests, 'refused before any directory or request'
    assert_nil GhWatch.parse_remote('git@github.com:../widgets.git')
    assert_nil GhWatch.parse_remote('https://github.com/acme/..')
    assert_equal ['github.com', 'acme', 'w.x'], GhWatch.parse_remote('git@github.com:acme/w.x.git')
    run_watch('--jsonl', '--wake-team', 'acme/..')
    assert_equal [2, "gh-watch: --wake-team must be ORG/SLUG\n"], [@status, @err]
  end

  def test_text_mode_once
    @gql = graphql(open: [pr(number: 6, created: ago(10))])
    run_watch('--once', '--text', '--repo', 'acme/widgets')
    assert_equal 0, @status, @err
    assert_includes @out, '[info] OPENED pr:6 open by alice "PR 6 title"'
    assert_includes @out, 'rateLimit cost 4' # heads 3 + details 1
  end

  # ---- repo resolution ----------------------------------------------------

  def test_parse_remote_forms
    want = ['github.com', 'acme', 'widgets']
    assert_equal want, GhWatch.parse_remote('https://github.com/acme/widgets.git')
    assert_equal want, GhWatch.parse_remote('https://github.com/acme/widgets')
    assert_equal want, GhWatch.parse_remote('git@github.com:acme/widgets.git')
    assert_equal want, GhWatch.parse_remote('ssh://git@github.com/acme/widgets.git')
    assert_equal ['example.ghe.com', 'acme', 'widgets.js'], GhWatch.parse_remote('git@example.ghe.com:acme/widgets.js')
    assert_nil GhWatch.parse_remote('/local/path/repo')
    assert_nil GhWatch.parse_remote('https://github.com/acme/widgets/extra')
  end

  def test_api_bases
    assert_equal 'https://api.github.com', GhWatch.api_bases('github.com')[:rest]
    assert_equal({ rest: 'https://example.ghe.com/api/v3', graphql: 'https://example.ghe.com/api/graphql' },
                 GhWatch.api_bases('example.ghe.com'))
  end

  def git_repo(remote_url, remote_name = 'origin')
    dir = File.join(@tmp, "repo-#{remote_name}")
    system('git', 'init', '-q', dir, exception: true)
    system('git', '-C', dir, 'remote', 'add', remote_name, remote_url, exception: true)
    dir
  end

  def test_resolution_from_ssh_and_https_remotes
    @gql = graphql
    [['git@github.com:acme/widgets.git', 'origin'], ['https://github.com/acme/widgets.git', 'upstream']].each do |url, name|
      dir = git_repo(url, name)
      run_watch('--once', '--text', '--state-dir', @state_dir,
                env: { 'WATCHER_REPO' => nil, 'WATCHER_HOST' => nil, 'WATCHER_CWD' => dir })
      assert_equal 0, @status, @err
      st = JSON.parse(File.read(File.join(@state_dir, 'state.json')))
      assert_equal 'acme/widgets', st['repo']
      assert_equal 'github.com', st['host']
    end
  end

  def test_not_a_git_repo
    run_watch('--once', '--text', env: { 'WATCHER_REPO' => nil, 'WATCHER_CWD' => @tmp })
    assert_equal 2, @status
    assert_match(/not a git repo/, @err)
  end

  def test_jsonl_with_cwd_but_no_repo_refuses_the_remote
    dir = git_repo('git@github.com:acme/widgets.git')
    run_watch(env: { 'WATCHER_REPO' => nil, 'WATCHER_HOST' => nil, 'WATCHER_CWD' => dir })
    assert_equal [2, "gh-watch: WATCHER_CWD is set without WATCHER_REPO; pass --repo OWNER/NAME\n"], [@status, @err]
    assert_empty server.requests
  end

  # ---- token safety ---------------------------------------------------------

  def test_http_refuses_unknown_host_and_plain_http
    http = GhWatch::Http.new(token: 't', auth_hosts: ['api.github.com'])
    e = assert_raises(GhWatch::ApiError) { http.request('GET', 'https://evil.example.com/x') }
    assert_match(/refusing to send auth/, e.message)
    e = assert_raises(GhWatch::ApiError) { http.request('GET', 'http://api.github.com/x') }
    assert_match(/non-https/, e.message)
  end

  def test_redirect_is_not_followed
    @routes['GET /repos/acme/widgets/pulls'] = ->(_) { [302, { 'Location' => 'https://evil.example.com/' }, ''] }
    run_watch
    assert_equal 2, @status
    assert_equal 1, server.requests.size
  end

  # GhWatch.token_for in a subprocess with the fake gh on PATH and only the
  # token variables given (the test API base path never calls it).
  def token_for(host, from_remote: false, env: {})
    full_env = { 'PATH' => "#{@bin}:#{ENV.fetch('PATH')}", 'GH_TOKEN' => nil, 'GITHUB_TOKEN' => nil,
                 'GH_ENTERPRISE_TOKEN' => nil, 'GITHUB_ENTERPRISE_TOKEN' => nil }.merge(env)
    code = 'load ARGV[0]; begin; print GhWatch.token_for(ARGV[1], from_remote: ARGV[2] == "1"); ' \
           'rescue GhWatch::Failure => e; warn e.message; exit 2; end'
    out, @err, st = Open3.capture3(full_env, RbConfig.ruby, '-e', code, SCRIPT, host, from_remote ? '1' : '0')
    @status = st.exitstatus
    out
  end

  def gh_log_lines
    File.exist?(@gh_log) ? File.readlines(@gh_log, chomp: true) : []
  end

  def test_remote_host_needs_gh_auth_status_and_gets_no_env_token
    env = { 'GH_ENTERPRISE_TOKEN' => 'env-secret' }
    token_for('evil.example.com', from_remote: true, env: env)
    assert_equal [2, "remote host evil.example.com is not logged in to gh; pass --host and --repo\n"], [@status, @err]
    assert_equal ['auth status --hostname evil.example.com ent='], gh_log_lines

    # A logged-in remote host still never sees the env token.
    File.write(@gh_log, '')
    token_for('ghe.example.com', from_remote: true, env: env)
    assert_equal 2, @status
    assert_match(/no gh auth for ghe\.example\.com/, @err)
    assert(gh_log_lines.all? { |l| l.end_with?('ent=') })

    # A host the user configured keeps its enterprise token.
    File.write(@gh_log, '')
    assert_equal 'env-secret', token_for('ghe.example.com', env: env)
    assert_equal ['auth token --hostname ghe.example.com ent=env-secret'], gh_log_lines
  end

  def test_test_api_base_never_gets_the_gh_token
    write_state(base_state)
    run_watch
    assert_equal 0, @status, @err
    refute File.exist?(@gh_log), 'gh is never asked for a token'
    assert_equal(["Bearer #{FAKE_TOKEN}"], server.requests.map { |r| r.headers['authorization'] }.uniq)

    write_state(base_state)
    run_watch(env: { 'GHWATCH_TEST_TOKEN' => 'chosen-by-test' })
    assert_equal 0, @status, @err
    assert_equal 'Bearer chosen-by-test', server.requests.last.headers['authorization']
    refute(server.requests.any? { |r| r.headers['authorization'].to_s.include?(TOKEN) })
  end

  def test_test_api_base_must_be_loopback
    %w[https://evil.example.com http://10.0.0.1:8080 not-a-url].each do |base|
      run_watch(env: { 'GHWATCH_TEST_API_BASE' => base })
      assert_equal [2, "gh-watch: GHWATCH_TEST_API_BASE must be a loopback URL\n"], [@status, @err], base
    end
    refute File.exist?(@gh_log), 'refused before any token is fetched'
  end

  def test_ghe_fallback_only_on_first_request_without_cache
    fake = Class.new do
      attr_reader :urls

      def initialize
        @urls = []
      end

      def request(_method, url, **)
        @urls << url
        url.start_with?('https://api.example.ghe.com/') ? [200, {}, '{"login":"x"}'] : [404, {}, '{}']
      end
    end
    bases = GhWatch.api_bases('example.ghe.com')
    http = fake.new
    api = GhWatch::Api.new(http: http, host: 'example.ghe.com', bases: bases, fallback: true)
    api.get('/repos/a/b/pulls')
    assert_equal 'https://api.example.ghe.com', api.bases[:rest]
    assert_equal %w[https://example.ghe.com/api/v3/repos/a/b/pulls https://api.example.ghe.com/repos/a/b/pulls], http.urls

    api = GhWatch::Api.new(http: fake.new, host: 'example.ghe.com', bases: bases, fallback: false)
    assert_raises(GhWatch::ApiError) { api.get('/repos/a/b/pulls') }

    # A later 404 (a team without read:org, say) never rewrites the bases.
    flaky = fake.new
    def flaky.request(_method, url, **)
      @urls << url
      @urls.size == 1 ? [200, {}, '{}'] : [404, {}, '{}']
    end
    api = GhWatch::Api.new(http: flaky, host: 'example.ghe.com', bases: bases, fallback: true)
    api.get('/repos/a/b/pulls')
    assert_raises(GhWatch::ApiError) { api.get('/orgs/a/teams/b/members') }
    assert_equal 'https://example.ghe.com/api/v3', api.bases[:rest]
  end

  # ---- query cost, cap, paging --------------------------------------------

  def test_nested_query_only_for_updated_prs
    write_state(base_state('prs' => { '5' => { 'head' => SHA_A, 'ci' => 'none' },
                                      '6' => { 'head' => SHA_A, 'ci' => 'none' } }))
    @gql = graphql(open: [pr(number: 5, updated: ago(30), comments: [comment(201, 'alice', ago(30))]),
                          pr(number: 6, updated: ago(4000), comments: [comment(202, 'alice', ago(10))])])
    assert_equal(['gh:comment:201'], run_watch.map { |e| e['id'] })
    main = server.main_queries.first.json['query']
    assert_includes main, 'pullRequests(states: [OPEN], first: 50'
    refute_includes main, 'reviews(', 'the heads query has no nested connections'
    assert_equal 1, server.detail_queries.size
    assert_equal({ 'owner' => 'acme', 'name' => 'widgets', 'n0' => 5 }, server.detail_queries.first.json['variables'])
    assert_equal 4, next_state['rate_limit']['cost']
  end

  def test_heads_beyond_the_cap_carry_over_until_refresh
    old = { '5' => { 'head' => SHA_A, 'ci' => 'none' }, '99' => { 'head' => SHA_A, 'ci' => 'none' } }
    write_state(base_state('prs' => old))
    @gql = graphql(open: [pr(number: 5, updated: ago(4000))])
    @gql['data']['repository']['open']['pageInfo'] = { 'hasNextPage' => true, 'endCursor' => 'NEXT' }
    @routes['POST /graphql'] = lambda do |req|
      if req.json['query'].include?('closed: pullRequests')
        [200, {}, @gql]
      else
        assert_equal 'NEXT', req.json['variables']['openAfter']
        [200, {}, { 'data' => { 'repository' => { 'open' => {
          'pageInfo' => { 'hasNextPage' => false }, 'nodes' => [pr(number: 99, updated: ago(9000), head: SHA_B, head_author: 'bob')]
        } }, 'rateLimit' => { 'cost' => 1, 'remaining' => 1 } } }]
      end
    end
    assert_empty run_watch
    assert_equal 1, server.graphql_requests.size, 'no paging between refreshes'
    assert_equal %w[5 99], next_state['prs'].keys.sort, '#99 keeps its snapshot'

    write_state(base_state('prs' => old, 'last_full' => ago(301)))
    assert_equal(["gh:push:99:#{SHA_B[0, 12]}"], run_watch.map { |e| e['id'] })
    assert_equal NOW.iso8601, next_state['last_full']
  end

  def test_cap_then_304_forces_a_query_for_the_dropped_events
    write_state(base_state)
    @gql = graphql(open: (1..205).map { |n| pr(number: n, created: ago(250 - n)) })
    assert_equal 200, run_watch.size
    st = next_state
    assert st['backlog']
    write_state(st)
    before = server.main_queries.size
    ids = run_watch.map { |e| e['id'] } # the PR etag now answers 304
    assert_equal 0, @status, @err
    assert_equal before + 1, server.main_queries.size
    assert_includes ids, 'gh:opened:205'
    refute next_state.key?('backlog')
    assert_equal NOW.iso8601, next_state['since']
  end

  def open_page(nodes, more)
    { 'data' => { 'repository' => { 'open' => {
      'pageInfo' => { 'hasNextPage' => more, 'endCursor' => more ? 'NEXT2' : nil }, 'nodes' => nodes
    } }, 'rateLimit' => { 'cost' => 1, 'remaining' => 1 } } }
  end

  def test_heads_page_on_while_updated_since_between_refreshes
    old = %w[5 6 7].to_h { |n| [n, { 'head' => SHA_A, 'ci' => 'none' }] }
    write_state(base_state('prs' => old))
    @gql = graphql(open: [pr(number: 5, updated: ago(30))])
    @gql['data']['repository']['open']['pageInfo'] = { 'hasNextPage' => true, 'endCursor' => 'NEXT' }
    pages = []
    @routes['POST /graphql'] = lambda do |req|
      q = req.json['query']
      if q.include?('closed: pullRequests') then [200, {}, @gql]
      elsif q.include?('p0: pullRequest(') then [200, {}, details_for(req)]
      else
        pages << req.json['variables']['openAfter']
        [200, {}, open_page([pr(number: 6, updated: ago(60), head: SHA_B, head_author: 'bob'),
                             pr(number: 7, updated: ago(9000))], true)]
      end
    end
    assert_equal(["gh:push:6:#{SHA_B[0, 12]}"], run_watch.map { |e| e['id'] })
    assert_equal 0, @status, @err
    assert_equal ['NEXT'], pages, 'stops once the last head is older than since'
    assert_equal %w[5 6 7], next_state['prs'].keys.sort
    assert_equal NOW.iso8601, next_state['since']
  end

  def test_truncated_connection_is_complete_when_it_already_reaches_since
    write_state(base_state('prs' => { '5' => { 'head' => SHA_A, 'ci' => 'none' } }))
    many = (1..100).map { |i| comment(1000 + i, 'bob', ago(250 - i)) }

    # Reaching back past since is complete even at the cap: no truncation.
    many[0] = comment(1001, 'bob', ago(4000))
    @gql = graphql(open: [pr(number: 5, comments: many, comments_more: true)])
    assert_equal 99, run_watch.size
    assert_equal 0, @status, @err
    assert_empty @err
    refute next_state['backlog']
    refute next_state.key?('resume')
  end

  def test_truncated_connection_resumes_from_a_cursor_without_duplicating
    write_state(base_state('prs' => { '5' => { 'head' => SHA_A, 'ci' => 'none' } }))
    # Ages 150..249s: inside qsince (420s back) so this poll truncates, but
    # old enough that the next poll's much tighter qsince (120s back, since
    # `since` is free to move forward once the resume cursor owns the gap)
    # already treats every one of them as before its window -- so the same
    # unchanged top page isn't re-emitted on the next poll.
    many = (1..100).map { |i| comment(1000 + i, 'bob', ago(250 - i)) }
    @gql = graphql(open: [pr(number: 5, comments: many, comments_more: true)])
    events1 = run_watch
    assert_equal 0, @status, @err
    assert_equal 100, events1.size, 'what was fetched is still emitted'
    assert_equal "gh-watch: acme/widgets#5 comments truncated at 100 nodes; " \
                 "resuming the rest over the next poll(s)\n", @err
    assert_equal NOW.iso8601, next_state['since'], "since keeps moving -- draining the gap doesn't wedge it"
    assert next_state['backlog']
    assert_equal 'CUR', next_state.dig('resume', '5:comments', 'cursor')

    # Second poll: commit the state, keep the same unchanged top page (nothing
    # new arrived), and answer the stored cursor's request with the rest of
    # the connection's history, finishing it off.
    write_state(next_state)
    older = (1..40).map { |i| comment(900 + i, 'bob', ago(299 - i)) }
    @routes['POST /graphql'] = lambda do |req|
      q = req.json['query']
      if q.include?('comments(last: 50')
        [200, {}, { 'data' => { 'repository' => { 'pullRequest' => {
          'comments' => { 'pageInfo' => { 'hasPreviousPage' => false, 'startCursor' => nil }, 'nodes' => older }
        } }, 'rateLimit' => { 'cost' => 1, 'remaining' => 1 } } }]
      elsif q.include?('p0: pullRequest(')
        [200, {}, details_for(req)]
      else
        [200, {}, @gql]
      end
    end
    events2 = run_watch
    assert_equal 0, @status, @err
    assert_empty @err, 'does not warn again while the same gap is still being drained'
    ids2 = events2.map { |e| e['id'] }
    assert_equal older.map { |c| "gh:comment:#{c['fullDatabaseId']}" }.sort, ids2.sort, 'the gap is fetched exactly once'
    assert_empty(ids2 & events1.map { |e| e['id'] }, 'no event already emitted is repeated')
    refute next_state.key?('resume'), 'the connection has fully drained'
    refute next_state['backlog']
  end

  def test_missing_details_is_a_failure
    write_state(base_state('prs' => { '5' => { 'head' => SHA_A, 'ci' => 'none' } }))
    @gql = graphql(open: [pr(number: 5, comments: [comment(201, 'alice', ago(30))])])
    @routes['POST /graphql'] = lambda do |req|
      if req.json['query'].include?('p0: pullRequest(')
        [200, {}, { 'data' => { 'repository' => nil, 'rateLimit' => { 'cost' => 1, 'remaining' => 1 } } }]
      else
        [200, {}, @gql]
      end
    end
    assert_empty run_watch
    assert_equal [2, "gh-watch: pull request details missing\n"], [@status, @err]
    refute File.exist?(File.join(@state_dir, 'state.json.next'))
  end

  def test_max_pages_is_a_failure
    write_state(base_state('etag' => @etag))
    @routes[/issues\?state=all&sort=updated&direction=asc/] = ->(_) { [200, {}, []] }
    @routes[%r{issues/comments\?}] = lambda do |_|
      [200, { 'Link' => "<#{server.base}/repos/acme/widgets/issues/comments?page=2>; rel=\"next\"" }, []]
    end
    run_watch('--jsonl', '--issues', 'on')
    assert_equal [2, "gh-watch: more than 20 pages from /repos/acme/widgets/issues/comments\n"], [@status, @err]
    refute File.exist?(File.join(@state_dir, 'state.json.next'))
  end

  def test_pending_ci_bypass_expires_after_an_hour
    write_state(base_state('etag' => @etag,
                           'prs' => { '5' => { 'head' => SHA_A, 'ci' => 'pending', 'head_at' => ago(3601) } }))
    run_watch
    assert_equal 0, @status, @err
    assert_empty server.graphql_requests
  end

  # ---- logins, reviews, errors ----------------------------------------------

  def test_me_is_case_insensitive
    write_state(base_state('me' => nil, 'prs' => { '5' => { 'head' => SHA_A, 'ci' => 'none' } }))
    @gql = graphql(open: [pr(number: 5, author: 'octocat', head: SHA_B, head_author: 'octocat',
                             reviews: [review(104, 'octocat', 'CHANGES_REQUESTED', ago(40))],
                             comments: [comment(201, 'alice', ago(30))])])
    ev = by_id(run_watch(env: { 'WATCHER_ME' => 'OctoCat' }))
    assert_equal 0, @status, @err
    refute ev.key?("gh:push:5:#{SHA_B[0, 12]}"), 'own push is skipped'
    assert_equal 'info', ev['gh:review:104']['kind']
    assert_equal 'act', ev['gh:comment:201']['kind'], 'still my PR'
  end

  def test_commented_review_wrapping_inline_comments_is_skipped
    write_state(base_state('prs' => { '5' => { 'head' => SHA_A, 'ci' => 'none' } }))
    @gql = graphql(open: [pr(number: 5, author: 'octocat',
                             reviews: [review(120, 'alice', 'COMMENTED', ago(40)),
                                       review(121, 'alice', 'COMMENTED', ago(30), 'overall: nice')],
                             threads: [thread(inline(310, 'alice', ago(40), 'a.rb', 'x', review: 120),
                                              inline(311, 'alice', ago(30), 'b.rb', 'y', review: 121))])])
    ev = by_id(run_watch)
    assert_equal %w[gh:inline:310 gh:inline:311 gh:review:121], ev.keys.sort
    assert_equal 'act', ev['gh:inline:310']['kind']
  end

  def test_unexpected_data_is_an_internal_error
    write_state(base_state)
    @gql = graphql(open: [pr(number: 5).merge('commits' => 'oops')])
    run_watch
    assert_equal [2, "gh-watch: internal error TypeError\n"], [@status, @err]
    refute File.exist?(File.join(@state_dir, 'state.json.next'))
  end

  # ---- id stability -------------------------------------------------------

  def test_ids_match_fixture
    fixture = File.readlines(File.expand_path('fixtures/gh-watch-ids.txt', __dir__), chomp: true)
                  .reject { |l| l.empty? || l.start_with?('#') }
    prs = { '5' => { 'head' => SHA_A, 'ci' => 'none', 'head_at' => ago(900) } }
    write_state(base_state('prs' => prs))
    @gql = graphql(open: [pr(number: 5, author: 'octocat', head: SHA_B, rollup: 'FAILURE', created: ago(100),
                             reviews: [review(234_442_896, 'alice', 'CHANGES_REQUESTED', ago(60))],
                             comments: [comment(1_234_567_890, 'bob', ago(50))],
                             threads: [thread(inline(987_654_321, 'carol', ago(40), 'a.rb', 'x'))])],
                   closed: [closed(number: 3, state: 'MERGED', closed_at: '2026-11-19T11:58:07Z'),
                            closed(number: 4, state: 'CLOSED', closed_at: '2026-11-19T11:57:00Z')])
    assert_equal fixture.sort, run_watch.map { |e| e['id'] }.sort
  end
end
