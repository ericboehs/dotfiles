# Claude Man - Claude Session Manager

A comprehensive command-line tool for managing Claude CLI sessions running in tmux panes. Monitor, send messages, handle menus, and control Claude sessions with ease.

## Installation

The `claude-man` script should be in your PATH. Ensure you have the following dependencies:

- `tmux` - For session management
- `fzf` - For interactive pane selection
- `terminal-notifier` (macOS) - For desktop notifications (optional)
- `slack-noti` - For Slack notifications (optional)

## Commands

### monitor
Monitor a Claude session and get notified when it goes idle.

```bash
claude-man monitor --pane 0:1.0                    # Monitor specific pane
claude-man monitor                                  # Interactive pane selection
claude-man monitor --pane 0:1.0 --notify           # Desktop notifications
claude-man monitor --pane 0:1.0 --notify-slack     # Slack notifications
claude-man monitor --pane 0:1.0 --timeout 90       # 90-second timeout
claude-man monitor --pane 0:1.0 --continuous        # Keep monitoring after idle
claude-man monitor --pane 0:1.0 --watch-context     # Warn on low context
```

**Options:**
- `--notify, -n` - Send desktop notification when session goes idle
- `--notify-always` - Send notification always (no sender restriction)
- `--notify-slack` - Send Slack notification when session goes idle
- `--continuous, -c` - Keep monitoring after session goes idle
- `--watch-context` - Notify when context drops below 10%
- `--timeout SECONDS` - Timeout after specified seconds (default: no timeout)

### send
Send messages to Claude sessions with full multi-line support.

```bash
# Simple message
claude-man send --pane 0:1.0 'Hello Claude'

# Multi-line from file
claude-man send --pane 0:1.0 --file message.txt

# From stdin (pipe)
echo -e "Line 1\nLine 2" | claude-man send --pane 0:1.0

# From stdin (redirect)
claude-man send --pane 0:1.0 < message.txt

# Heredoc
claude-man send --pane 0:1.0 <<EOF
Multi-line message
with code blocks:

\`\`\`python
def hello():
    print("Hello World")
\`\`\`
EOF

# Interactive mode
claude-man send --pane 0:1.0  # Prompts for input, supports multi-line
```

**Message Priority:** File > stdin > argument > interactive

### select
Navigate Claude's menu options automatically.

```bash
# Simple yes/no
claude-man select --pane 0:1.0 yes              # Select "Yes"
claude-man select --pane 0:1.0 no               # Select "No"

# 3-option menus (Yes/Yes and don't ask/No)
claude-man select --pane 0:1.0 yes              # First option
claude-man select --pane 0:1.0 2                # Second option
claude-man select --pane 0:1.0 no2              # Third option (No)

# Numbered options
claude-man select --pane 0:1.0 1                # Select option 1
claude-man select --pane 0:1.0 2                # Select option 2

# Case insensitive
claude-man select --pane 0:1.0 Y                # Works
claude-man select --pane 0:1.0 YES              # Works
```

**Supported selections:**
- `yes`, `YES`, `Yes`, `y`, `Y` - First option
- `no`, `NO`, `No`, `n`, `N` - Second option  
- `no2`, `NO2`, `No2` - Third option (for 3-option menus)
- `1-9` - Numbered options

### interrupt
Interrupt Claude when it's going in the wrong direction.

```bash
claude-man interrupt --pane 0:1.0               # Interrupt specific pane
claude-man interrupt                             # Interactive selection
```

Sends: `Escape` + `Escape` + `i` (with 0.1s delays between keys)

### view
View the current session output.

```bash
claude-man view --pane 0:1.0                    # View specific pane
claude-man view                                  # Interactive selection
```

### list
List all active Claude sessions.

```bash
claude-man list
```

## Global Options

- `--pane, -p PANE` - Specify pane to use (e.g., 0:1.0)
- `--help, -h` - Show help message

## Interactive Mode

Run `claude-man` without arguments to enter interactive mode with a menu interface.

## Pane Format

Panes are specified in tmux format: `session:window.pane`

Examples:
- `0:1.0` - Session 0, Window 1, Pane 0
- `2:3.1` - Session 2, Window 3, Pane 1

## Notifications

### Desktop Notifications (macOS)
Requires `terminal-notifier`:
```bash
brew install terminal-notifier
```

### Slack Notifications
Requires `slack-noti` script in PATH and `BOEHS_SLACK_NOTI_HOOK` environment variable set.

## Advanced Usage

### Monitoring with Timeout
Perfect for checking on long-running tasks:
```bash
claude-man monitor --pane 0:1.0 --timeout 300  # 5-minute timeout
```

When timeout occurs:
```
⏰ TIMEOUT after 300 seconds
Session 0:1.0 (✳ Calendar Tool) did not go idle within the timeout period.

💡 To continue monitoring, run:
   claude-man monitor --pane 0:1.0 --timeout 300
```

### Complex Message Sending
```bash
# Send a complex prompt with code
claude-man send --pane 0:1.0 <<'EOF'
Please review this code and suggest improvements:

```python
def process_data(data):
    results = []
    for item in data:
        if item.is_valid():
            results.append(item.process())
    return results
```

Focus on:
1. Performance optimization
2. Error handling
3. Code readability
EOF
```

### Automated Workflows
```bash
#!/bin/bash
# Send a task and monitor until completion
claude-man send --pane 0:1.0 "Implement user authentication"
claude-man monitor --pane 0:1.0 --timeout 1800  # 30 min timeout

# If it needs confirmation, select yes
claude-man select --pane 0:1.0 yes

# Continue monitoring
claude-man monitor --pane 0:1.0 --notify-slack
```

## Troubleshooting

### No Claude Sessions Found
- Ensure Claude CLI is running in tmux
- Check that tmux sessions exist: `tmux list-sessions`
- Verify pane exists: `tmux list-panes -a`

### fzf Required Error
Install fzf or use `--pane` option to specify pane directly:
```bash
brew install fzf
```

### Notifications Not Working
- **Desktop**: Install `terminal-notifier`
- **Slack**: Ensure `slack-noti` is in PATH and webhook is configured

### Multi-line Messages Not Sending
- Ensure proper quoting in heredocs
- Use `cat` to verify file contents before sending
- Check for special characters that might need escaping

## Examples

### Development Workflow
```bash
# Start monitoring a development session
claude-man monitor --pane 0:1.0 --notify-slack &

# Send a complex task
claude-man send --pane 0:1.0 --file task_description.txt

# When Claude asks for confirmation, approve it
claude-man select --pane 0:1.0 yes

# If Claude goes off track, interrupt and redirect
claude-man interrupt --pane 0:1.0
claude-man send --pane 0:1.0 "Please focus on the authentication logic only"
```

### Code Review Session
```bash
claude-man send --pane 0:1.0 <<EOF
Please review this pull request:

$(git diff main..feature-branch)

Provide feedback on:
- Code quality
- Security concerns  
- Performance implications
- Test coverage
EOF
```

### Interactive Debugging
```bash
# Send error logs for analysis
cat error.log | claude-man send --pane 0:1.0

# Monitor with timeout since debugging can take time
claude-man monitor --pane 0:1.0 --timeout 600 --watch-context
```

## Integration with Other Tools

### Git Hooks
```bash
# In a git hook
if claude-man list | grep -q "Code Review"; then
    git diff HEAD~1 | claude-man send --pane 0:1.0
fi
```

### CI/CD Integration
```bash
# Send test results to Claude for analysis
if [ "$CI_BUILD_STATUS" = "failed" ]; then
    cat test_output.log | claude-man send --pane 0:1.0
    claude-man monitor --pane 0:1.0 --timeout 300 --notify-slack
fi
```

## Tips

1. **Use descriptive pane titles** in tmux for easier identification
2. **Combine commands** for complex workflows using shell scripts
3. **Set up aliases** for frequently used commands:
   ```bash
   alias cm='claude-man'
   alias cms='claude-man send --pane 0:1.0'
   alias cmm='claude-man monitor --pane 0:1.0 --notify-slack'
   ```
4. **Use timeout with notifications** for unattended monitoring
5. **Leverage heredocs** for complex, multi-line prompts
6. **Monitor context** on long sessions to avoid auto-compaction

## License

This tool is part of your personal automation toolkit.