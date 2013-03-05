#!/usr/bin/ruby

IRB.conf[:SAVE_HISTORY] = 10000
IRB.conf[:HISTORY_FILE] = "#{ENV['HOME']}/.irb_history"

IRB.conf[:PROMPT_MODE] = :SIMPLE

%w[rubygems irb/completion irb/ext/save-history awesome_print interactive_editor].each do |gem|
  begin
    require gem
  rescue LoadError
  end
end

load File.dirname(__FILE__) + '/.railsrc' if ($0 == 'irb' && ENV['RAILS_ENV']) || ($0 == 'script/rails' && Rails.env)
