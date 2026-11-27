# frozen_string_literal: true

# Tests for .config/gitleaks/config.toml, the global pre-commit hook config
# (.gitconfig's [hook "gitleaks"]) that runs against every repo, VA repos
# included. Run: ruby test/gitleaks_config_test.rb
#
# Nightly review 2026-11-26 found a `contract/threads/*.json|rb` path
# exemption added to this *global* allowlist for one repo's synthetic
# secret-mask test vectors: a real token committed to a matching path in any
# other repo -- VA repos included -- would never be scanned. The exemption
# was removed; this guards against it (or something shaped like it) coming
# back here instead of living in that repo's own .gitleaksignore fingerprints
# (the hook always passes `-c ~/.config/gitleaks/config.toml`, so a
# repo-level .gitleaks.toml is never read).

require 'minitest/autorun'
require 'fileutils'
require 'open3'
require 'securerandom'
require 'tmpdir'

CONFIG = File.expand_path('../.config/gitleaks/config.toml', __dir__)
GITLEAKS = ENV['GITLEAKS_BIN'] || 'gitleaks'

class GitleaksConfigTest < Minitest::Test
  def setup
    skip 'gitleaks not on PATH' unless system("command -v #{GITLEAKS} >/dev/null 2>&1")
  end

  # A token-shaped secret with enough entropy to trip the default
  # generic-api-key rule (not one of this file's own custom rules), so this
  # test fails loudly if gitleaks' own defaults ever stop catching it.
  # Generated fresh at runtime, not a literal in this source file: a fixed
  # secret-shaped string committed here would be exactly the kind of thing
  # this test exists to make sure never slips through unscanned.
  def secret_line
    "export API_TOKEN=#{SecureRandom.alphanumeric(28)}\n"
  end

  def scan(relative_path)
    Dir.mktmpdir('gitleaks-config-test') do |dir|
      target = File.join(dir, relative_path)
      FileUtils.mkdir_p(File.dirname(target))
      File.write(target, secret_line)
      _out, _err, status = Dir.chdir(dir) do
        Open3.capture3(GITLEAKS, 'detect', '--no-git', '--no-banner', '-s', '.', '-c', CONFIG)
      end
      status
    end
  end

  def test_a_secret_under_contract_threads_is_caught_everywhere_this_global_config_runs
    # This is the path the removed exemption used to blanket-allow in every
    # repo. It must be scanned like any other path now.
    status = scan('contract/threads/foo.json')
    assert status.exited?
    assert_equal 1, status.exitstatus, 'a real-looking secret under contract/threads/ must not be silently allowlisted'
  end

  def test_a_secret_under_contract_threads_rb_is_also_caught
    status = scan('contract/threads/foo.rb')
    assert_equal 1, status.exitstatus
  end

  def test_rails_encrypted_credentials_stay_allowlisted
    # Regression guard: fixing the overly broad contract/threads exemption
    # must not touch the legitimate, narrowly-scoped credentials.yml.enc one.
    status = scan('config/credentials.yml.enc')
    assert_equal 0, status.exitstatus, 'Rails encrypted credentials ciphertext must stay allowlisted'
  end

  def test_config_has_no_path_only_exemption_for_contract_threads
    # Matches an actual allowlist path pattern entry (a quoted regex
    # literal), not this test's own prose mentioning the path below.
    toml = File.read(CONFIG)
    refute_match(%r{'''[^']*contract/threads[^']*'''}, toml,
                 "a repo-specific exemption (contract/threads) does not belong in this global config; put it in " \
                 "that repo's own .gitleaksignore fingerprints instead")
  end

  def test_the_repo_specific_exemption_note_points_at_gitleaksignore_not_gitleaks_toml
    # The hook only ever passes `-c ~/.config/gitleaks/config.toml` (see
    # .gitconfig's [hook "gitleaks"]): gitleaks does not also merge in a
    # repo's own .gitleaks.toml when -c is given, so advice to put a
    # repo-specific exemption there would silently do nothing.
    toml = File.read(CONFIG)
    note = toml[/# NOTE:.*?\n(?:\s*#.*\n)*/]
    assert note, 'expected a NOTE comment about repo-specific exemptions'
    assert_match(/belongs in that repo's own\s*\n?\s*#?\s*\.gitleaksignore fingerprints/, note,
                 'the recommended fix must be .gitleaksignore fingerprints')
    refute_match(/belongs in that repo's own\s*\n?\s*#?\s*\.gitleaks\.toml/, note,
                 'a repo-level .gitleaks.toml is never read by the global -c hook, so it must not be recommended')
  end
end
