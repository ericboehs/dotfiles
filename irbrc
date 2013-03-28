#!/usr/bin/ruby

ARGV.concat [ "--readline", "--prompt-mode", "simple" ]

IRB.conf[:AUTO_INDENT]  = true
IRB.conf[:EVAL_HISTORY] = 1000000
IRB.conf[:SAVE_HISTORY] = 1000000
IRB.conf[:HISTORY_FILE] = "#{ENV['HOME']}/.irb_history"

IRB.conf[:PROMPT_MODE] = :SIMPLE

%w[irb/completion irb/ext/save-history awesome_print interactive_editor].each do |gem|
  begin
    require gem
  rescue LoadError
    warn "Could not load #{gem}"
  end
end

railsrc_path = File.expand_path('~/.railsrc')
if ( ENV['RAILS_ENV'] || defined? Rails ) && File.exist?( railsrc_path )
  begin
    load railsrc_path
  rescue Exception
    warn "Could not load: #{ railsrc_path } because of #{$!.message}"
  end
end

class Object
  def interesting_methods
    case self.class
    when Class
      self.public_methods.sort - Object.public_methods
    when Module
      self.public_methods.sort - Module.public_methods
    else
      self.public_methods.sort - Object.new.public_methods
    end
  end
end

def efind(email)
  User.where(email: email).first!
end

def r
  reload!
end
