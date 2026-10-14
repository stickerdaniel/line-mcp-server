// Template rendered by `line-mcp install`, which fills in the {{...}} values.
// line-mcp's scheduled task runs this with wscript.exe //B //Nologo //E:JScript.
// It sets the daemon's environment, runs the daemon hidden through cmd.exe,
// which appends its output to the log, waits, and exits with its exit code.
// Windows Script Host JScript, ASCII only: a call on the left of `=` sets a
// variable of this process, which the daemon inherits.
var shell = new ActiveXObject('WScript.Shell');
var env = shell.Environment('Process');
{{ENVIRONMENT}}
WScript.Quit(shell.Run({{COMMAND}}, 0, true));
