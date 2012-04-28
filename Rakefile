require 'rake'
require 'erb'

desc "install the dot files into user's home directory"
task :install do
  replace_all = false

  # Additional files that aren't caught with Dir['*']
  files =  Dir['*'] << "vim/janus/vim/vimrc" << "vim/janus/vim/gvimrc" 

  # Files that should have a different destination symlink
  diff_dest = { 
    "vim/janus/vim/vimrc"  => "vimrc",
    "vim/janus/vim/gvimrc" => "gvimrc",
    "dieter_mod.zsh-theme" => "oh-my-zsh/themes/dieter_mod.zsh-theme",
  }
  
  files.each do |file|
    # Setup some shortcuts
    dest_file   = file
    dest_file   = diff_dest[file] if diff_dest[file]
    dest_file_no_erb = dest_file.sub('.erb', '')
    dest_file_full_path = File.join(ENV['HOME'], ".#{dest_file_no_erb}")
    
    # Drop the fluff files
    next if %w[Rakefile README.rdoc LICENSE].include? file

    # Check if the file exists (removing the erb file extension)
    if File.exist? dest_file_full_path
      if File.identical? file, dest_file_full_path
        puts "identical ~/.#{dest_file_no_erb}"
      elsif replace_all
        replace_file(file, dest_file)
      else
        print "overwrite ~/.#{dest_file_no_erb}? [ynaq] "
        response = $stdin.gets.chomp
        case response
        when 'a'
          replace_all = true
          replace_file(file, dest_file)
        when 'y'
          replace_file(file, dest_file)
        when 'q'
          exit
        else
          puts "skipping ~/.#{dest_file_no_erb}"
        end
      end
    else
      link_file(file, dest_file)
    end
  end
end

def replace_file(file, dest_file=file)
  dest_file_no_erb = file.sub('.erb', '')
  system %Q{rm -rf "$HOME/.#{dest_file_no_erb}"}
  link_file(file, dest_file)
end

def link_file(file, dest_file=file)
  # Setup some shortcuts
  dest_file_no_erb = file.sub('.erb', '')
  dest_file_full_path = File.join(ENV['HOME'], ".#{dest_file_no_erb}")

  if file =~ /.erb$/
    puts "generating ~/.#{dest_file_no_erb}"
    File.open(dest_file_full_path, 'w') do |new_file|
      new_file.write ERB.new(File.read(file)).result(binding)
    end
  else
    if dest_file != file
      puts "linking ~/.#{dest_file} for #{dest_file_no_erb}"
    else
      puts "linking ~/.#{dest_file_no_erb}"
    end
    system %Q{ln -s "$PWD/#{file}" "$HOME/.#{dest_file}"}
  end
end
