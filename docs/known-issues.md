# Known issues

## Linux computer use is limited on Wayland

Cue's computer-use driver works best on X11. Some view and control actions are unavailable under Wayland.

Use an X11 session when you need full computer control.

## Chrome and Edge cookies using v20 encryption cannot be imported directly on Windows

Export the cookies to a file with a browser extension, then import that file in Cue.

## Local agents keep their own global settings

Some local-agent CLIs save the selected model or account globally. Changing that setting in Cue can also affect the same CLI in a terminal.

Choose **CLI default** when you do not want Cue to change the CLI's global model.
