Output demos/gemini-search-progress.gif
Set FontSize 18
Set Width 1320
Set Height 820
Set Padding 20
Set Framerate 30
Set Shell "bash"

Hide
Type "tmux kill-session -t geminidemo 2>/dev/null || true"
Enter
Sleep 400ms
Type "tmux new-session -d -s geminidemo 'bash /home/mobrienv/projects/pi-gemini-search/demos/run-gemini-demo.sh'"
Enter
Sleep 500ms
Show
Type "tmux attach -t geminidemo"
Enter
Sleep 55s
Type "exit"
Enter
Sleep 1s
