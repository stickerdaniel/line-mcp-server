// cscript.exe //Nologo //E:JScript task-state.js <task name>
// Prints the scheduled task's state through Schedule.Service as one JSON line
// for line-mcp's Task Scheduler backend (src/service/task-scheduler.ts):
//   {"exists":true,"state":n,"enabled":b,"instances":n,"lastResult":n,"command":"...","arguments":"..."}
//   {"exists":false}, only when the task is not found (0x80070002)
//   {"error":n}, the HRESULT of any other failure
// `command` and `arguments` are the task's first action. Only ASCII leaves it,
// so no code page matters: every other character is written as \uXXXX.
// Windows Script Host JScript, run in place from the package; it changes nothing.
function quote(text) {
	var out = '"';
	for (var i = 0; i < text.length; i++) {
		var code = text.charCodeAt(i);
		if (code < 0x20 || code > 0x7e || code === 0x22 || code === 0x5c) {
			out += '\\u' + ('000' + code.toString(16)).slice(-4);
		} else out += text.charAt(i);
	}
	return out + '"';
}

// COM errors carry a negative HRESULT.
function hresult(error) {
	return error.number >>> 0;
}

var answer;
try {
	var service = new ActiveXObject('Schedule.Service');
	service.Connect();
	var task = null;
	try {
		task = service.GetFolder('\\').GetTask(WScript.Arguments.Item(0));
	} catch (error) {
		if (hresult(error) !== 0x80070002) throw error;
	}
	if (task === null) answer = '{"exists":false}';
	else {
		var action = task.Definition.Actions.Item(1);
		var exec = action.Type === 0;
		answer =
			'{"exists":true,"state":' +
			task.State +
			',"enabled":' +
			(task.Enabled ? 'true' : 'false') +
			',"instances":' +
			task.GetInstances(0).Count +
			',"lastResult":' +
			(task.LastTaskResult >>> 0) +
			',"command":' +
			quote(exec ? '' + action.Path : '') +
			',"arguments":' +
			quote(exec ? '' + action.Arguments : '') +
			'}';
	}
} catch (error) {
	answer = '{"error":' + hresult(error) + '}';
}
WScript.StdOut.WriteLine(answer);
