import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder: 'testbed/workspace',
	launchArgs: ['--remote-debugging-port=9237'],
	useInstallation: process.env.VSCODE_TEST_EXECUTABLE
		? { fromPath: process.env.VSCODE_TEST_EXECUTABLE }
		: undefined,
});
