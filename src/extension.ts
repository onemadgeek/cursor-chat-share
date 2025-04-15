import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';

interface Settings {
	checkInterval: number;
}

const DEFAULT_SETTINGS: Settings = {
	checkInterval: 5000
};

interface Workspace {
	id: string;
	path: string;
	project?: string;
	lastModified?: string;
	chatCount: number;
	composerCount: number;
	chatData?: any;
	composerData?: any;
}

interface Composer {
	composerId: string;
	name?: string;
	text?: string;
	richText?: {
		text?: string;
		conversation?: Message[];
	};
	conversation?: Message[];
	status?: {
		conversation?: Message[];
	};
	context?: {
		conversation?: Message[];
	};
	createdAt: number;
	lastUpdatedAt: number;
	unifiedMode?: string;
	forceMode?: string;
	isAgentic?: boolean;
}

interface Tab {
	id: string;
	title: string;
	messages: Message[];
	lastUpdatedAt: number;
}

interface Message {
	type: 'user' | 'assistant';
	text: string;
	timestamp?: number;
	isAction?: boolean;
}

interface WorkspaceResponse {
	tabs: Tab[];
	composers: {
		allComposers: Composer[];
	};
}

interface ChatMessage {
	type?: number | string;
	role?: string;
	text?: string;
	content?: string;
}

interface ComposerData {
	allComposers: Array<{
		composerId: string;
		name?: string;
		text?: string;
		createdAt?: number;
		lastUpdatedAt?: number;
		conversation?: Message[];
	}>;
}

interface GlobalStorageResult {
	key: string;
	value: string;
}


interface MessageState {
	composerId: string;
	lastMessageCount: number;
	lastMessageTimestamp: number;
}

let outputChannel: vscode.OutputChannel;
let messageStates: Map<string, MessageState> = new Map();
let checkInterval: NodeJS.Timeout | null = null;
let currentSettings: Settings = { ...DEFAULT_SETTINGS };
let shareStatusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
	console.log('=== Extension Activation Started ===');
	console.log('Extension context:', {
		extensionPath: context.extensionPath,
		globalStoragePath: context.globalStoragePath,
		subscriptions: context.subscriptions.length
	});

	outputChannel = vscode.window.createOutputChannel('Cursor Chat Share');

	try {
		const savedSettings = context.globalState.get<Settings>('settings');
		if (savedSettings) {
			currentSettings = { ...DEFAULT_SETTINGS, ...savedSettings };
		} 

		console.log('Registering helloWorld command...');

		console.log('Registering showCursorChats command...');
		const showCursorChatsDisposable = vscode.commands.registerCommand('cursor-chat-share.showCursorChats', async () => {
			try {
				const currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (!currentWorkspace) {
					vscode.window.showErrorMessage('Please open a folder or workspace first.');
					return;
				}

				const platform = process.platform;
				const homeDir = os.homedir();
				let WORKSPACE_PATH;
				
				switch (platform) {
					case 'win32':
						WORKSPACE_PATH = path.join(process.env.APPDATA || '', 'Cursor', 'User', 'workspaceStorage');
						break;
					case 'darwin':
						WORKSPACE_PATH = path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage');
						break;
					case 'linux':
						WORKSPACE_PATH = path.join(homeDir, '.config', 'Cursor', 'User', 'workspaceStorage');
						break;
					default:
						throw new Error('Unsupported operating system');
				}

				const currentProjectName = path.basename(currentWorkspace);

				const panel = vscode.window.createWebviewPanel(
					'cursorChats',
					'Cursor Chats',
					vscode.ViewColumn.One,
					{
						enableScripts: true
					}
				);

				panel.webview.html = getLoadingContent();

				const entries = await fs.promises.readdir(WORKSPACE_PATH, { withFileTypes: true });

				for (const entry of entries) {
					if (!entry.isDirectory()) continue;

					const workspaceJsonPath = path.join(WORKSPACE_PATH, entry.name, 'workspace.json');
					const dbPath = path.join(WORKSPACE_PATH, entry.name, 'state.vscdb');

					if (!fs.existsSync(dbPath) || !fs.existsSync(workspaceJsonPath)) {
						continue;
					}

					try {
						const workspaceData = JSON.parse(await fs.promises.readFile(workspaceJsonPath, 'utf-8'));
						const projectPath = workspaceData.folder;
						const projectName = projectPath ? path.basename(projectPath.replace(/^file:\/\/\/?/, '')) : '';

						if (projectName === currentProjectName) {
							await showWorkspaceDetail(entry.name, WORKSPACE_PATH, context, panel);
							return;
						}
					} catch (error) {
						continue;
					}
				}

				panel.webview.html = getErrorContent(new Error('No Cursor chat data found for the current workspace.'));

			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
				vscode.window.showErrorMessage(`Failed to show Cursor chats: ${errorMessage}`);
			}
		});
		console.log('Show Cursor Chats command registered successfully');

		console.log('Registering shareChat command...');
		const shareChatDisposable = vscode.commands.registerCommand('cursor-chat-share.shareChat', async () => {
			try {
				const workspaces = await getCurrentCursorWorkspace();
				if (workspaces.length === 0) {
					vscode.window.showInformationMessage('No Cursor chat data found for sharing.');
					return;
				}
				
				const { workspaceId, workspacePath } = workspaces[0];
				
				const dbPath = path.join(workspacePath, workspaceId, 'state.vscdb');
				if (!fs.existsSync(dbPath)) {
					vscode.window.showErrorMessage('No chat database found for the current workspace.');
					return;
				}
				
				const db = await open({
					filename: dbPath,
					driver: sqlite3.Database
				});
				
				const composerKeys = [
					'composer.composerData',
					'cursor.composerData',
					'cursorComposerData',
					'workbench.panel.composer'
				];
				
				let composerData = null;
				for (const key of composerKeys) {
					const result = await db.get(`
						SELECT value FROM ItemTable 
						WHERE [key] = ?
					`, [key]);
					
					if (result?.value) {
						try {
							composerData = JSON.parse(result.value);
							break;
						} catch (e) {
							continue;
						}
					}
				}
				
				if (!composerData?.allComposers?.length) {
					vscode.window.showInformationMessage('No chat conversations found to share.');
					return;
				}
				
				interface ComposerQuickPickItem extends vscode.QuickPickItem {
					composerId: string;
				}
				
				const composerItems: ComposerQuickPickItem[] = composerData.allComposers.map((composer: any) => ({
					label: composer.name || `Chat ${composer.composerId.slice(0, 8)}`,
					description: `Last updated: ${new Date(composer.lastUpdatedAt).toLocaleString()}`,
					composerId: composer.composerId
				}));
				
				const selectedComposer = await vscode.window.showQuickPick(composerItems, {
					placeHolder: 'Select a chat to share'
				});
				
				if (!selectedComposer) return;
				
				const messages = await loadChatMessages(workspacePath, workspaceId, selectedComposer.composerId);
				
				if (!messages.length) {
					vscode.window.showInformationMessage('No messages found in this chat.');
					return;
				}
				
				const formattedChat = messages.map(msg => {
					const role = msg.type === 'user' ? 'User' : 'Assistant';
					return `${role}: ${msg.text}`;
				}).join('\n\n---\n\n');
				
				const document = await vscode.workspace.openTextDocument({ content: '', language: 'markdown' });
				const editor = await vscode.window.showTextDocument(document);
				
				const header = `# Shared Chat: ${selectedComposer.label}\n\nExported on: ${new Date().toLocaleString()}\n\n---\n\n`;
				
				await editor.edit(editBuilder => {
					const position = new vscode.Position(0, 0);
					editBuilder.insert(position, header + formattedChat);
				});

				const action = await vscode.window.showInformationMessage(
					'Chat exported successfully. What would you like to do?',
					'Copy to Clipboard',
					'Save As...'
				);
				
				if (action === 'Copy to Clipboard') {
					await vscode.env.clipboard.writeText(header + formattedChat);
					vscode.window.showInformationMessage('Chat copied to clipboard!');
				} else if (action === 'Save As...') {
					const saveUri = await vscode.window.showSaveDialog({
						defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Desktop', `cursor-chat-${Date.now()}.md`)),
						filters: {
							'Markdown': ['md'],
							'Text': ['txt'],
							'All Files': ['*']
						}
					});
					
					if (saveUri) {
						await vscode.workspace.fs.writeFile(saveUri, Buffer.from(header + formattedChat));
						vscode.window.showInformationMessage(`Chat saved to ${saveUri.fsPath}`);
					}
				}
				
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
				vscode.window.showErrorMessage(`Failed to share chat: ${errorMessage}`);
			}
		});
		console.log('Share Chat command registered successfully');

		shareStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		shareStatusBarItem.text = "$(share) Share Chat";
		shareStatusBarItem.tooltip = "Share your Cursor chat history";
		shareStatusBarItem.command = 'cursor-chat-share.shareChat';
		shareStatusBarItem.show();
		
		context.subscriptions.push(
			showCursorChatsDisposable, 
			shareChatDisposable,
			shareStatusBarItem
		);
		console.log('Commands added to subscriptions');

		vscode.commands.getCommands().then(commands => {
			console.log('=== Registered Commands ===');
			console.log('All commands:', commands);
			console.log('Our commands:', commands.filter(cmd => cmd.startsWith('cursor-chat-share.')));
		});

		startMessageChecking();

		context.subscriptions.push({
			dispose: () => {
				if (checkInterval) {
					clearInterval(checkInterval);
					checkInterval = null;
				}
			}
		});

		console.log('=== Extension Activation Completed Successfully ===');
	} catch (error) {
		console.error('=== Extension Activation Error ===');
		console.error('Error during activation:', error);
		throw error;
	}

}

function getLoadingContent() {
	return `
		<!DOCTYPE html>
		<html>
		<head>
			<meta charset="UTF-8">
			<style>
				body { padding: 20px; font-family: var(--vscode-font-family); }
				.loading { text-align: center; }
			</style>
		</head>
		<body>
			<div class="loading">
				<h2>Loading Cursor Chats...</h2>
				<p>Please wait while we fetch your chat history.</p>
			</div>
		</body>
		</html>
	`;
}

function getErrorContent(error: any) {
	return `
		<!DOCTYPE html>
		<html>
		<head>
			<meta charset="UTF-8">
			<style>
				body { padding: 20px; font-family: var(--vscode-font-family); }
				.error { color: var(--vscode-errorForeground); }
			</style>
		</head>
		<body>
			<div class="error">
				<h2>Error Loading Cursor Chats</h2>
				<p>${error.message || 'An unknown error occurred'}</p>
			</div>
		</body>
		</html>
	`;
}


function getWebviewContent(workspaces: Workspace[]) {
	return `<!DOCTYPE html>
	<html>
		<head>
			<meta charset="UTF-8">
			<style>
				body {
					padding: 0;
					margin: 0;
					color: var(--vscode-editor-foreground);
					background-color: var(--vscode-editor-background);
					display: flex;
					height: 100vh;
				}
				.sidebar {
					width: 200px;
					background-color: var(--vscode-sideBar-background);
					border-right: 1px solid var(--vscode-panel-border);
					padding: 20px 0;
					display: flex;
					flex-direction: column;
				}
				.main-content {
					flex: 1;
					padding: 20px;
					overflow-y: auto;
				}
				.tab-buttons {
					display: flex;
					flex-direction: column;
					gap: 5px;
					margin-bottom: 20px;
				}
				.tab-button {
					padding: 10px 15px;
					background-color: transparent;
					border: none;
					color: var(--vscode-editor-foreground);
					cursor: pointer;
					text-align: left;
					display: flex;
					align-items: center;
					gap: 8px;
					transition: background-color 0.2s;
				}
				.tab-button:hover {
					background-color: var(--vscode-list-hoverBackground);
				}
				.tab-button.active {
					background-color: var(--vscode-list-activeSelectionBackground);
					color: var(--vscode-list-activeSelectionForeground);
					border-left: 3px solid var(--vscode-activityBar-activeBorder);
				}
				.tab-content {
					display: none;
					height: 100%;
					overflow-y: auto;
				}
				.tab-content.active {
					display: block;
				}
				.refresh-button {
					background-color: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
					color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
					border: none;
					padding: 4px 12px;
					border-radius: 3px;
					cursor: pointer;
					font-size: 0.85em;
					display: inline-flex;
					align-items: center;
					gap: 4px;
					margin: 0 0 12px 0;
					transition: background-color 0.2s;
					float: right;
				}
				.refresh-button:hover {
					background-color: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
				}
				.refresh-button svg {
					width: 12px;
					height: 12px;
				}
				.refresh-button.refreshing {
					opacity: 0.7;
					cursor: not-allowed;
				}
				.refresh-button.refreshing svg {
					animation: spin 1s linear infinite;
				}
				@keyframes spin {
					to {transform: rotate(360deg);}
				}
				.chats-header {
					display: flex;
					justify-content: space-between;
					align-items: center;
					margin-bottom: 16px;
					padding-bottom: 8px;
					border-bottom: 1px solid var(--vscode-panel-border);
				}
				.chats-title {
					font-size: 1.1em;
					font-weight: 500;
					color: var(--vscode-editor-foreground);
					margin: 0;
				}
				@keyframes pulse {
					0% {
						box-shadow: 0 0 0 0 rgba(55, 148, 255, 0.4);
					}
					70% {
						box-shadow: 0 0 0 10px rgba(55, 148, 255, 0);
					}
					100% {
						box-shadow: 0 0 0 0 rgba(55, 148, 255, 0);
					}
				}
				.has-new-messages {
					border-left-color: var(--vscode-activityBar-activeBorder) !important;
					background-color: rgba(55, 148, 255, 0.1) !important;
				}
				.workspace-item {
					margin-bottom: 20px;
					padding: 15px;
					border: 1px solid var(--vscode-panel-border);
					border-radius: 4px;
					background-color: var(--vscode-editor-background);
				}
				.workspace-title {
					font-weight: bold;
					margin-bottom: 10px;
					color: var(--vscode-editor-foreground);
				}
				.workspace-info {
					font-size: 0.9em;
					color: var(--vscode-descriptionForeground);
					margin-bottom: 10px;
				}
				.chat-item {
					margin: 8px 0;
					padding: 8px;
					cursor: pointer;
					border-radius: 4px;
					transition: background-color 0.2s;
					display: flex;
					align-items: center;
					justify-content: space-between;
					border-left: 3px solid transparent;
				}
				.chat-item:hover {
					background-color: var(--vscode-list-hoverBackground);
				}
				.chat-item.active {
					background-color: var(--vscode-list-activeSelectionBackground);
					color: var(--vscode-list-activeSelectionForeground);
					border-left-color: var(--vscode-activityBar-activeBorder);
				}
				.chat-count {
					font-size: 0.8em;
					color: var(--vscode-descriptionForeground);
					margin-left: 8px;
				}
				.active-indicator {
					font-size: 0.8em;
					color: var(--vscode-activityBar-activeBorder);
					background-color: var(--vscode-activityBar-activeBackground);
					padding: 2px 6px;
					border-radius: 3px;
					margin-left: 8px;
				}
				.chat-content {
					margin-top: 10px;
					padding: 10px;
					background-color: var(--vscode-editor-background);
					border: 1px solid var(--vscode-panel-border);
					border-radius: 4px;
					display: none;
					max-height: 500px;
					overflow-y: auto;
				}
				.chat-content.active {
					display: block;
					border-left: 3px solid var(--vscode-activityBar-activeBorder);
				}
				.message {
					margin: 8px 0;
					padding: 8px;
					border-radius: 4px;
				}
				pre {
					background-color: var(--vscode-editor-background);
					padding: 8px;
					border-radius: 4px;
					overflow-x: auto;
					margin: 8px 0;
				}
				code {
					font-family: var(--vscode-editor-font-family);
					font-size: 0.9em;
				}
				.empty-state {
					color: var(--vscode-descriptionForeground);
					text-align: center;
					padding: 20px;
				}
				.user-message {
					background-color: var(--vscode-editor-background);
					border: 1px solid var(--vscode-panel-border);
					border-left: 4px solid #3794ff;
					margin: 12px 0 12px 20%;
					padding: 12px;
					border-radius: 6px;
				}
				.assistant-message {
					background-color: var(--vscode-editorWidget-background);
					border: 1px solid var(--vscode-panel-border);
					border-left: 4px solid #a371f7;
					margin: 12px 20% 12px 0;
					padding: 12px;
					border-radius: 6px;
				}
				.message-header {
					margin-bottom: 8px;
					font-size: 0.9em;
					display: flex;
					justify-content: space-between;
				}
				.message-type {
					font-weight: bold;
					color: var(--vscode-editor-foreground);
				}
				.loading-spinner {
					display: inline-block;
					width: 20px;
					height: 20px;
					border: 2px solid var(--vscode-editor-foreground);
					border-radius: 50%;
					border-top-color: transparent;
					animation: spin 1s linear infinite;
				}
				@keyframes spin {
					to {transform: rotate(360deg);}
				}
				.loading-messages {
					text-align: center;
					padding: 20px;
					color: var(--vscode-descriptionForeground);
				}
				.action-buttons {
					display: flex;
					gap: 8px;
					margin-top: 8px;
				}
				.action-button {
					background-color: var(--vscode-button-background);
					color: var(--vscode-button-foreground);
					border: none;
					padding: 4px 8px;
					border-radius: 3px;
					cursor: pointer;
					font-size: 0.9em;
				}
				.action-button:hover {
					background-color: var(--vscode-button-hoverBackground);
				}
				.action-button:disabled {
					opacity: 0.5;
					cursor: not-allowed;
				}
				.settings-form {
					max-width: 400px;
					margin: 0 auto;
					padding: 20px;
				}
				.form-group {
					margin-bottom: 20px;
				}
				.form-group label {
					display: block;
					margin-bottom: 8px;
					color: var(--vscode-editor-foreground);
				}
				.form-group input {
					width: 100%;
					padding: 8px;
					background-color: var(--vscode-input-background);
					color: var(--vscode-input-foreground);
					border: 1px solid var(--vscode-input-border);
					border-radius: 4px;
				}
				.save-button {
					background-color: var(--vscode-button-background);
					color: var(--vscode-button-foreground);
					border: none;
					padding: 8px 16px;
					border-radius: 4px;
					cursor: pointer;
				}
				.save-button:hover {
					background-color: var(--vscode-button-hoverBackground);
				}
				.action-message {
					font-style: italic;
					opacity: 0.8;
					background-color: var(--vscode-editor-background);
					border-left: 3px solid var(--vscode-activityBarBadge-background);
				}
				.action-message .message-content {
					color: var(--vscode-descriptionForeground);
				}

				.action-message {
					font-style: italic;
					border-left: 3px solid #f5c200 !important; /* Use yellow for actions */
					background-color: rgba(245, 194, 0, 0.1) !important;
					margin-left: 20%;
					margin-right: 20%;
				}

				.message-header {
					margin-bottom: 8px;
					font-size: 0.9em;
					display: flex;
					justify-content: space-between;
				}

				.message-type {
					font-weight: bold;
					color: var(--vscode-editor-foreground);
				}

				.action-message .message-type {
					color: #f5c200;
				}

				.action-message {
					font-style: italic;
					border-left: 3px solid #f5c200 !important;
					background-color: rgba(245, 194, 0, 0.05) !important;
					margin: 8px 20%;
					padding: 8px;
					font-size: 0.9em;
				}

				.action-message .message-header {
					margin-bottom: 4px;
					font-size: 0.85em;
					color: #b08500;
				}

				.action-message .message-content {
					color: var(--vscode-descriptionForeground);
					line-height: 1.4;
				}

				.message-header {
					margin-bottom: 6px;
					font-size: 0.9em;
					display: flex;
					justify-content: space-between;
					align-items: center;
				}

				.message-type {
					font-weight: 500;
					color: var(--vscode-editor-foreground);
				}

				.action-message .message-type {
					color: #f5c200;
				}

				.action-message {
					font-style: italic;
					font-size: 0.9em;
					margin: 8px 20%;
					padding: 8px;
					background-color: rgba(245, 194, 0, 0.05);
					border-left: 3px solid #f5c200;
					color: var(--vscode-descriptionForeground);
					line-height: 1.4;
				}

				.action-message .message-header {
					margin-bottom: 4px;
					font-size: 0.85em;
					color: #b08500;
				}

				.action-message .message-type {
					color: #f5c200;
				}

				.action-message .message-content {
					color: var(--vscode-descriptionForeground);
				}

			</style>
		</head>
		<body>
			<div class="sidebar">
				<div class="tab-buttons">
					<button class="tab-button active" data-tab="chats" onclick="switchTab('chats')">
						<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
						</svg>
						Chats
					</button>
					<button class="tab-button" data-tab="settings" onclick="switchTab('settings')">
						<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<circle cx="12" cy="12" r="3"/>
							<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
						</svg>
						Settings
					</button>
				</div>
			</div>
			<div class="main-content">
				<div class="tab-content active" data-tab="chats">
					<div class="chats-header">
						<h2 class="chats-title">Chat History</h2>
						<button class="refresh-button" onclick="refreshChats()">
							<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
								<path fill="currentColor" d="M14.9 7.5a7 7 0 0 0-13.8 0h2.1a5 5 0 0 1 9.6 0h2.1zm-2.1 1a5 5 0 0 1-9.6 0H1.1a7 7 0 0 0 13.8 0h-2.1z"/>
							</svg>
							Refresh
						</button>
					</div>
					${workspaces.map(workspace => `
						<div class="workspace-item">
							<div class="workspace-title">${workspace.project}</div>
							<div class="workspace-info">
								Last modified: ${workspace.lastModified ? new Date(workspace.lastModified).toLocaleString() : 'Unknown'}
							</div>
							<div class="workspace-info">
								Total chats: ${workspace.composerData?.allComposers?.length || 0}
							</div>
							${workspace.composerData?.allComposers?.map((composer: any) => `
								<div class="chat-item" onclick="toggleChat('${workspace.id}', '${composer.composerId}')">
									<div>
										${composer.name || 'Unnamed Chat'}
										<span class="chat-count">${composer.lastUpdatedAt ? new Date(composer.lastUpdatedAt).toLocaleString() : 'Unknown'}</span>
									</div>
									<div class="action-buttons">
										<button class="action-button" onclick="event.stopPropagation(); downloadChat('${workspace.id}', '${composer.composerId}', '${composer.name || 'Unnamed Chat'}')">
											Download
										</button>
									</div>
								</div>
								<div id="chat-content-${composer.composerId}" class="chat-content">
									<div class="loading-messages">
										<div class="loading-spinner"></div>
										<p>Loading messages...</p>
									</div>
								</div>
							`).join('') || '<div class="empty-state">No chats found</div>'}
						</div>
					`).join('')}
				</div>
				<div class="tab-content" data-tab="settings">
					<h2>Settings</h2>
					<div class="settings-form">
						<div class="form-group">
							<label for="checkInterval">Message Check Interval (milliseconds)</label>
							<input type="number" id="checkInterval" value="${currentSettings.checkInterval}" min="1000" step="1000">
						</div>
						<button class="save-button" onclick="saveSettings()">Save Settings</button>
					</div>
				</div>
			</div>
			<script>
				const vscode = acquireVsCodeApi();
				let activeChat = null;
				let loadedChats = new Set();
				let currentSettings = ${JSON.stringify(currentSettings)};
				let autoRefreshInterval = null;

				// Start auto-refresh when the page loads
				initAutoRefresh();

				function initAutoRefresh() {
					// Clear any existing interval
					if (autoRefreshInterval) {
						clearInterval(autoRefreshInterval);
					}
					
					// Set up auto-refresh every 10 seconds if there's an active chat
					autoRefreshInterval = setInterval(() => {
						if (activeChat) {
							loadChatMessages(activeChat);
						}
					}, 10000); // 10 second refresh interval
				}

				function switchTab(tabName) {
					// Update tab buttons
					document.querySelectorAll('.tab-button').forEach(button => {
						button.classList.remove('active');
						if (button.dataset.tab === tabName) {
							button.classList.add('active');
						}
					});

					// Update tab contents
					document.querySelectorAll('.tab-content').forEach(content => {
						content.classList.remove('active');
						if (content.dataset.tab === tabName) {
							content.classList.add('active');
						}
					});
				}

				function toggleChat(workspaceId, composerId) {
					const chatContent = document.getElementById('chat-content-' + composerId);
					const chatItem = chatContent.previousElementSibling;

					if (activeChat === composerId) {
						chatContent.classList.remove('active');
						chatItem.classList.remove('active');
						activeChat = null;
					} else {
						// Hide previously active chat
						if (activeChat) {
							document.getElementById('chat-content-' + activeChat).classList.remove('active');
							document.querySelector('.chat-item.active')?.classList.remove('active');
						}

						chatContent.classList.add('active');
						chatItem.classList.add('active');
						activeChat = composerId;

						// Always load fresh messages when toggling to a chat
						loadChatMessages(composerId);
					}
				}

				function loadChatMessages(composerId) {
					// Show loading indicator in the chat content
					const chatContent = document.getElementById('chat-content-' + composerId);
					if (chatContent && !chatContent.querySelector('.loading-messages')) {
						const existingContent = chatContent.innerHTML;
						const loadingHtml = '<div class="loading-messages"><div class="loading-spinner"></div><p>Refreshing messages...</p></div>';
						
						// Only show loading indicator if this is a fresh load, not an update
						if (!loadedChats.has(composerId)) {
							chatContent.innerHTML = loadingHtml;
						}
					}
					
					vscode.postMessage({
						command: 'loadChatMessages',
						data: { composerId }
					});
				}

				function downloadChat(workspaceId, composerId, chatName) {
					vscode.postMessage({
						command: 'downloadChatHistory',
						data: { composerId, chatName }
					});
				}

				function saveSettings() {
					const checkInterval = parseInt(document.getElementById('checkInterval').value);
					const newSettings = {
						checkInterval: checkInterval
					};

					vscode.postMessage({
						command: 'saveSettings',
						data: newSettings
					});
				}

				function refreshChats() {
					const refreshButton = document.querySelector('.refresh-button');
					refreshButton.classList.add('refreshing');
					refreshButton.disabled = true;

					// Clear loaded chats cache
					loadedChats.clear();
					
					// If there's an active chat, remember it
					const activeComposerId = activeChat;

					vscode.postMessage({ command: 'refreshChats' });

					// Set up a one-time check to restore active chat after refresh
					if (activeComposerId) {
						const checkForChat = setInterval(() => {
							const chatContent = document.getElementById('chat-content-' + activeComposerId);
							if (chatContent) {
								clearInterval(checkForChat);
								toggleChat(null, activeComposerId); // Workspace ID not needed here
								loadChatMessages(activeComposerId);
							}
						}, 100);

						// Clear the interval after 5 seconds if chat not found
						setTimeout(() => clearInterval(checkForChat), 5000);
					}
				}

				window.addEventListener('message', event => {
					const message = event.data;

					switch (message.command) {
						case 'chatMessagesLoaded':
							const { composerId, messages } = message.data;
							const chatContent = document.getElementById('chat-content-' + composerId);
							
							if (chatContent) {
								loadedChats.add(composerId);
								chatContent.innerHTML = renderMessages(messages);
								
								// If this is the active chat, make sure it's visible
								if (activeChat === composerId) {
									chatContent.classList.add('active');
									const chatItem = chatContent.previousElementSibling;
									if (chatItem) {
										chatItem.classList.add('active');
									}
								}
								
								const messagesContainer = document.getElementById('chat-messages-' + composerId);
								if (messagesContainer) {
									messagesContainer.dataset.messages = JSON.stringify(messages);
								}
							}
							break;

						case 'chatMessagesError':
							const errorContent = document.getElementById('chat-content-' + message.data.composerId);
							if (errorContent) {
								errorContent.innerHTML = '<div class="empty-state">Error loading messages</div>';
							}
							break;

						case 'refreshComplete':
							const refreshButton = document.querySelector('.refresh-button');
							refreshButton.classList.remove('refreshing');
							refreshButton.disabled = false;
							
							// Reset auto-refresh
							initAutoRefresh();
							break;
							
						case 'newMessagesAvailable':
							// If we have an active chat, refresh it immediately when new messages are available
							if (activeChat) {
								console.log('New messages available notification received');
								// Add a subtle visual indicator that new messages are available
								const chatItem = document.querySelector('.chat-item.active');
								if (chatItem) {
									chatItem.classList.add('has-new-messages');
									// Add a pulsing effect
									chatItem.style.animation = 'pulse 2s infinite';
									// Reset animation after 5 seconds
									setTimeout(() => {
										chatItem.style.animation = '';
										chatItem.classList.remove('has-new-messages');
									}, 5000);
								}
								// Refresh the chat content
								loadChatMessages(activeChat);
							}
							break;
					}
				});

				// Clean up interval when the webview is disposed
				window.addEventListener('unload', () => {
					if (autoRefreshInterval) {
						clearInterval(autoRefreshInterval);
						autoRefreshInterval = null;
					}
				});

				function renderMessages(messages) {
					if (!messages || messages.length === 0) {
						return '<div class="empty-state">No messages in this chat</div>';
					}

					return \`
						<div id="chat-messages-\${activeChat}" class="messages-container">
							\${messages.map((message, index) => {
								// Determine if this is an action message and format accordingly
								const isAction = message.isAction === true;
								const messageClass = \`\${message.type}-message message \${isAction ? 'action-message' : ''}\`;
								
								// Format the message header differently for actions
								let header = '';
								if (isAction) {
									header = \`<span class="message-type">Action</span>\`;
								} else {
									header = \`<span class="message-type">\${message.type === 'user' ? 'You' : 'Assistant'}</span>\`;
								}
								
								return \`
									<div class="\${messageClass}">
										<div class="message-header">
											\${header}
											<span class="message-index">#\${index + 1}</span>
										</div>
										<div class="message-content">\${formatMessageContent(message.text || '')}</div>
									</div>
								\`;
							}).join('')}
						</div>
					\`;
				}

				function formatMessageContent(text) {
					if (!text || typeof text !== 'string') return '';
					
					// Replace newlines with <br>
					text = text.replace(/\\n/g, '<br>');
					
					// Wrap code blocks
					text = text.replace(/\`\`\`([^]+?)\`\`\`/g, '<pre><code>$1</code></pre>');
					text = text.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
					
					return text;
				}
			</script>
		</body>
	</html>`;
}


export function deactivate() {
	if (checkInterval) {
		clearInterval(checkInterval);
		checkInterval = null;
	}
}

async function showWorkspaceDetail(workspaceId: string, workspacePath: string, context: vscode.ExtensionContext, existingPanel?: vscode.WebviewPanel) {
	const panel = existingPanel || vscode.window.createWebviewPanel(
		'cursorChats', // Use the same viewType as the initial panel
		`Cursor Chats: ${workspaceId}`,
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(workspacePath)],
			enableCommandUris: true
		}
	);

	panel.webview.onDidReceiveMessage(async message => {
		if (message.command === 'downloadChatHistory') {
			try {
				const { chatName, composerId } = message.data;
				
				const messages = await loadChatMessages(workspacePath, workspaceId, composerId);
				
				if (!messages || messages.length === 0) {
					vscode.window.showWarningMessage('No messages found in this chat');
					return;
				}

				let markdown = `# Chat History: ${chatName}\n\n`;
				markdown += `Generated on: ${new Date().toLocaleString()}\n\n`;
				markdown += `Total Messages: ${messages.length}\n\n`;
				markdown += `---\n\n`;
				
				messages.forEach((msg: Message, index: number) => {
					const role = msg.type === 'user' ? 'You' : 'Assistant';
					const messageNumber = index + 1;
					const timestamp = msg.timestamp ? new Date(msg.timestamp).toLocaleString() : 'Unknown time';
					
					markdown += `### ${role} (Message #${messageNumber}) - ${timestamp}\n\n`;
					markdown += `${msg.text || ''}\n\n`;
					markdown += `---\n\n`;
				});

				const fileName = `${chatName.replace(/[^a-zA-Z0-9]/g, '_')}_chat_history.md`;
				const untitledUri = vscode.Uri.parse(`untitled:${fileName}`);
				const document = await vscode.workspace.openTextDocument(untitledUri);
				const editor = await vscode.window.showTextDocument(document);
				
				await editor.edit(editBuilder => {
					const position = new vscode.Position(0, 0);
					editBuilder.insert(position, markdown);
				});

				vscode.window.showInformationMessage(`Chat history saved as ${fileName} - use Ctrl+S or Cmd+S to save to disk`);
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
				vscode.window.showErrorMessage(`Failed to create chat history: ${errorMessage}`);
			}
		} else if (message.command === 'loadChatMessages') {
			try {
				const { composerId } = message.data;
				const messages = await loadChatMessages(workspacePath, workspaceId, composerId);
				panel.webview.postMessage({ 
					command: 'chatMessagesLoaded',
					data: {
						composerId,
						messages
					}
				});
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
				panel.webview.postMessage({ 
					command: 'chatMessagesError',
					data: {
						composerId: message.data.composerId,
						error: errorMessage
					}
				});
			}
		} else if (message.command === 'refreshChats') {
			try {
				messageStates.clear();
				
				const workspaces = await getCurrentCursorWorkspace();
				
				if (workspaces.length === 0) {
					panel.webview.postMessage({ command: 'refreshComplete' });
					return;
				}

				const workspacesData = [];

				for (const workspace of workspaces) {
					const { workspaceId: currentWorkspaceId, workspacePath: currentWorkspacePath } = workspace;
					
					const dbPath = path.join(currentWorkspacePath, currentWorkspaceId, 'state.vscdb');
					const db = await open({
						filename: dbPath,
						driver: sqlite3.Database
					});

					let composerData = null;
					const composerKeys = [
						'composer.composerData',
						'cursor.composerData',
						'cursorComposerData',
						'workbench.panel.composer'
					];

					for (const key of composerKeys) {
						const result = await db.get(`SELECT value FROM ItemTable WHERE [key] = ?`, [key]);
						if (result?.value) {
							try {
								const parsed = JSON.parse(result.value);
								if (parsed.allComposers) {
									composerData = parsed;
									for (const composer of parsed.allComposers) {
										const messages = await loadChatMessages(currentWorkspacePath, currentWorkspaceId, composer.composerId);
										composer.conversation = messages;
									}
									break;
								}
							} catch (e) {
								continue;
							}
						}
					}

					await db.close();

					workspacesData.push({
						id: currentWorkspaceId,
						path: dbPath,
						project: currentWorkspaceId,
						lastModified: (await fs.promises.stat(dbPath)).mtime.toISOString(),
						chatCount: 0,
						composerCount: composerData?.allComposers?.length || 0,
						composerData: composerData
					});
				}
				panel.webview.html = getWebviewContent(workspacesData) as string;
				panel.webview.postMessage({ command: 'refreshComplete' });
				
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
				panel.webview.postMessage({ command: 'refreshComplete' });
			}
		} else if (message.command === 'saveSettings') {
			try {
				const newSettings = message.data;
				
				currentSettings = { ...currentSettings, ...newSettings };
				
				await context.globalState.update('settings', currentSettings);
				
				vscode.window.showInformationMessage('Settings saved successfully');
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
				vscode.window.showErrorMessage(`Failed to save settings: ${errorMessage}`);
			}
		}
	});
	try {
		const workspaces = await getCurrentCursorWorkspace();
		if (workspaces.length > 0) {
			const workspacesData = await Promise.all(workspaces.map(async workspace => {
				const dbPath = path.join(workspace.workspacePath, workspace.workspaceId, 'state.vscdb');
				const db = await open({
					filename: dbPath,
					driver: sqlite3.Database
				});

				let composerData = null;
				const composerKeys = [
					'composer.composerData',
					'cursor.composerData',
					'cursorComposerData',
					'workbench.panel.composer'
				];

				for (const key of composerKeys) {
					const result = await db.get(`SELECT value FROM ItemTable WHERE [key] = ?`, [key]);
					if (result?.value) {
						try {
							const parsed = JSON.parse(result.value);
							if (parsed.allComposers) {
								composerData = parsed;
								break;
							}
						} catch (e) {
							continue;
						}
					}
				}

				await db.close();

				return {
					id: workspace.workspaceId,
					path: dbPath,
					project: workspace.workspaceId,
					lastModified: (await fs.promises.stat(dbPath)).mtime.toISOString(),
					chatCount: 0,
					composerCount: composerData?.allComposers?.length || 0,
					composerData: {
						allComposers: composerData?.allComposers?.map((composer: any) => ({
							composerId: composer.composerId,
							name: composer.name,
							text: composer.text,
							createdAt: composer.createdAt,
							lastUpdatedAt: composer.lastUpdatedAt
						})) || []
					}
				};
			}));

			panel.webview.html = getWebviewContent(workspacesData) as string;
		} else {
			panel.webview.html = getErrorContent(new Error('No Cursor chat data found for the current workspace.'));
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
		panel.webview.html = getErrorContent(new Error(errorMessage));
	}
}

async function loadChatMessages(workspacePath: string, workspaceId: string, composerId: string): Promise<Message[]> {
    const globalStoragePaths = [
        path.join(workspacePath, '..', 'globalStorage', 'state.vscdb'),
        path.join(vscode.env.appRoot, '..', 'User', 'globalStorage', 'state.vscdb')
    ];

    ;
    
    for (const globalDbPath of globalStoragePaths) {
        if (!fs.existsSync(globalDbPath)) {
            ;
            continue;
        }

        try {
            ;
            const globalDb = await open({
                filename: globalDbPath,
                driver: sqlite3.Database,
                mode: sqlite3.OPEN_READONLY | sqlite3.OPEN_PRIVATECACHE
            });

            const tables = ['cursorDiskKV', 'ItemTable'];
            
            for (const table of tables) {
                try {
                    const tableCheck = await globalDb.get(
                        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, 
                        [table]
                    );
                    
                    if (!tableCheck) {
                        ;
                        continue;
                    }

                    ;
                    const composerContent = await globalDb.get<GlobalStorageResult>(
                        `SELECT [key], value FROM ${table} WHERE [key] = ?`,
                        [`composerData:${composerId}`]
                    );

                    if (composerContent?.value) {
                        ;
                        let content;
                        try {
                            content = JSON.parse(composerContent.value);
                        } catch (parseError) {
                            ;
                            await globalDb.close();
                            continue;
                        }
                        
                        await globalDb.close();
                        
                        const messages = processConversation(content, { composerId });
                        
                        const processedMessages: Message[] = [];
                        for (const msg of messages) {
                            if (typeof msg.type === 'number') {
								msg.type = msg.type === 1 ? 'user' : 'assistant';
							} else if (msg.type !== 'user' && msg.type !== 'assistant') {
								msg.type = 'assistant'; // Default
							}
							if (msg.isAction && msg.text) {
								if (msg.text.startsWith('Action: ')) {
									msg.text = msg.text.substring('Action: '.length);
								}
							}
                            if (content.conversation && Array.isArray(content.conversation)) {
                                const originalMsg = content.conversation.find(
                                    (bubble: any) => bubble.timingInfo?.clientEndTime === msg.timestamp
                                );
                                
                                if (originalMsg) {
                                    if (originalMsg.cachedConversationSummary?.summary) {
                                        const fileChanges = extractModifiedFileInfo(originalMsg, null);
                                        if (fileChanges) {
                                            msg.text = fileChanges;
                                            msg.isAction = true;
                                        }
                                    }
                                    
                                    if (originalMsg.checkpoint || originalMsg.afterCheckpoint) {
                                        const fileInfo = extractModifiedFileInfo(originalMsg.checkpoint, originalMsg.afterCheckpoint);
                                        if (fileInfo && !msg.text.includes(fileInfo)) {
                                            msg.text = fileInfo + '\n\n' + msg.text;
                                            msg.isAction = true;
                                        }
                                    }
                                }
                            }
                            
                            processedMessages.push(msg);
                        }
                        
                        ;
                        return processedMessages;
                    } else {
                        ;
                    }
                } catch (e) {
                    ;
                    continue;
                }
            }

            await globalDb.close();
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            ;
            continue;
        }
    }

    ;
    return [];
}

function extractModifiedFileInfo(checkpoint: any, afterCheckpoint: any): string | null {
    const diffs = afterCheckpoint?.activeInlineDiffs || checkpoint?.activeInlineDiffs;
    
    if (!diffs || !Array.isArray(diffs) || diffs.length === 0) {
        return null;
    }
    
    const fileChanges: string[] = [];
    
    for (const diff of diffs) {
        let fileName = 'unknown';
        if (diff.uri?.path) {
            const pathParts = diff.uri.path.split('/');
            fileName = pathParts[pathParts.length - 1];
        } else if (diff.uri?.external) {
            const pathParts = diff.uri.external.split('/');
            fileName = pathParts[pathParts.length - 1];
        }
        
        if (diff.original && typeof diff.original.startLineNumber === 'number' && 
            typeof diff.original.endLineNumberExclusive === 'number') {
            
            const startLine = diff.original.startLineNumber;
            const endLine = diff.original.endLineNumberExclusive - 1;
            const lineRange = startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;
            
            let changeType = 'Modified';
            if (diff.original?.content === '') {
                changeType = 'Added';
            } else if (diff.modified && Array.isArray(diff.modified)) {
                if (diff.modified.length === 0) {
                    changeType = 'Removed';
                } else if (diff.modified.length > (endLine - startLine + 1)) {
                    changeType = 'Added';
                } else if (diff.modified.length < (endLine - startLine + 1)) {
                    changeType = 'Removed';
                }
            }
            
            fileChanges.push(`${changeType} ${fileName} (${lineRange})`);
        } else {
            fileChanges.push(`Modified ${fileName}`);
        }
    }
    
    return fileChanges.length > 0 ? fileChanges.join(' • ') : null;
}


function processConversation(content: any, composer: ComposerData['allComposers'][0]): Message[] {
    if (!content && !composer) {
        return [];
    }

    const conversationSources = [
        content?.conversation,
        content?.messages,
        content?.history,
        content?.richText?.conversation,
        content?.richText?.messages,
        content?.status?.conversation,
        content?.context?.conversation,
        content?.bubbles,
        content?.chat?.messages,
        content?.data?.messages,
        Array.isArray(content) ? content : null,
        composer?.conversation
    ];

    for (const source of conversationSources) {
        if (Array.isArray(source) && source.length > 0) {
            const messages = source.map((msg, index) => {
                const typeNum = determineMessageType(msg);
                const type: 'user' | 'assistant' = typeNum === 1 ? 'user' : 'assistant';
                
                let text = '';
                let isAction = false;
                let actionDescription = null;

                if (msg.cachedConversationSummary?.summary) {
                    const fileChanges = extractModifiedFileInfo(msg, null);
                    if (fileChanges) {
                        actionDescription = fileChanges;
                    }
                }

                if (!actionDescription && (msg.checkpoint || msg.afterCheckpoint)) {
                    actionDescription = extractModifiedFileInfo(msg.checkpoint, msg.afterCheckpoint);
                }

                if (!actionDescription && msg.capabilitiesRan) {
					const capabilityDescriptions: {[key: string]: string} = {
						'grep_search': 'Text search',
						'read_file': 'Read file',
						'edit_file': 'Modified file',
						'codebase_search': 'Searched codebase',
						'list_dir': 'Listed directory',
						'file_search': 'Searched for files'
					};
					
					for (const [capability, values] of Object.entries(msg.capabilitiesRan)) {
						if (Array.isArray(values) && values.length > 0 && 
							capabilityDescriptions[capability]) {
							actionDescription = `Action: ${capabilityDescriptions[capability]}`;
							break;
						}
					}
                }

                if (typeof msg === 'string') {
                    text = msg;
                } else if (msg && typeof msg === 'object') {
                    if (msg.richText) {
                        try {
                            const richTextObj = typeof msg.richText === 'string' ? 
                                JSON.parse(msg.richText) : msg.richText;
                            
                            if (richTextObj.root?.children) {
                                text = richTextObj.root.children
                                    .map((child: any) => {
                                        if (child.children) {
                                            return child.children
                                                .map((textNode: any) => textNode.text || '')
                                                .join(' ');
                                        }
                                        return child.text || '';
                                    })
                                    .filter(Boolean)
                                    .join('\n');
                            }
                        } catch (e) {
                            if (typeof msg.richText === 'string') {
                                text = msg.richText;
                            }
                        }
                    }

                    if (!text) {
                        const textFields = [
                            msg.text,
                            msg.content,
                            msg.message,
                            msg.value,
                            msg.body,
                            msg.data,
                            msg.markdown,
                            msg.plainText,
                            msg.messageText,
                            msg.displayText,
                            msg.contentText
                        ];

                        for (const field of textFields) {
                            if (typeof field === 'string' && field.trim().length > 0) {
                                text = field;
                                break;
                            }
                        }
                    }

                    if ((!text || text.trim().length === 0) && actionDescription) {
                        text = actionDescription;
                        isAction = true;
                    }

                    if (!text && msg.text && typeof msg.text === 'object') {
                        try {
                            text = JSON.stringify(msg.text, null, 2);
                        } catch (e) {
                            text = '[Complex message content]';
                        }
                    }
                }
                if (text && actionDescription && !isAction) {
                    text = `${actionDescription}\n\n${text}`;
                }

                if (!text) {
                    text = actionDescription || '[Empty message]';
                    if (actionDescription) isAction = true;
                }

                const possibleTimestamps = [
                    msg.timestamp,
                    msg.createdAt,
                    msg.time,
                    msg.date,
                    msg.created,
                    msg.createTime,
                    msg.created_at,
                    msg.updatedAt,
                    msg.updated_at,
                    msg.lastModified,
                    msg.modified,
                    msg.modifiedTime,
                    msg.timingInfo?.clientStartTime,
                    msg.timingInfo?.clientEndTime,
                    content.lastUpdatedAt,
                    composer.lastUpdatedAt,
                    Date.now()
                ];

                const timestamp = possibleTimestamps.find(t => 
                    typeof t === 'number' && t > 0
                ) || Date.now();

                return {
                    type,
                    text,
                    timestamp,
                    isAction: isAction || actionDescription !== null
                };
            }).filter(msg => msg.text && msg.text !== '[Empty message]');

            return messages;
        }
    }

    if (content && typeof content === 'object' && content.key && content.key.startsWith('composerData:') && content.value) {
        try {
            const parsed = typeof content.value === 'string' ? JSON.parse(content.value) : content.value;
            if (parsed.conversation && Array.isArray(parsed.conversation)) {
                return processConversation(parsed, composer);
            }
        } catch (e) {
            console.error('Error parsing content value:', e);
        }
    }

    return [];
}

function determineMessageType(msg: any): number {
    if (typeof msg.type === 'number') {
        return msg.type;
    } else if (msg.type === 'user') {
        return 1;
    } else if (msg.type === 'assistant') {
        return 2;
    }
    
    if (msg.role === 'user' || msg.sender === 'user' || msg.from === 'user') {
        return 1; // User message
    } else if (msg.role === 'assistant' || msg.sender === 'assistant' || msg.from === 'assistant') {
        return 2; // Assistant message
    }
    
    if (msg.isCapabilityIteration || msg.isThought || msg.isAgentic || 
        (msg.capabilitiesRan && Object.keys(msg.capabilitiesRan).length > 0)) {
        return 2;
    }
    
    return 2;
}

function startMessageChecking() {
	if (checkInterval) {
		clearInterval(checkInterval);
	}

	let lastSelectedComposerIds: string[] = [];

	checkInterval = setInterval(async () => {
		try {
			const workspaces = await getCurrentCursorWorkspace();
			if (workspaces.length === 0) {
				return;
			}

			for (const workspace of workspaces) {
				const { workspaceId, workspacePath } = workspace;
				const dbPath = path.join(workspacePath, workspaceId, 'state.vscdb');

				if (!fs.existsSync(dbPath)) {
					;
					continue;
				}

				const db = await open({
					filename: dbPath,
					driver: sqlite3.Database
				});

				try {
					const selectedResult = await db.get(`
						SELECT value FROM ItemTable 
						WHERE [key] = 'cursor.composerData' 
						OR [key] = 'composer.composerData'
						LIMIT 1
					`);

					if (!selectedResult?.value) {
						;
						continue;
					}

					let selectedIds: string[] = [];
					try {
						const data = JSON.parse(selectedResult.value);
						selectedIds = data.selectedComposerIds || [];
						
						if (JSON.stringify(selectedIds) !== JSON.stringify(lastSelectedComposerIds)) {
							lastSelectedComposerIds = selectedIds;
						}
					} catch (e) {
						;
						continue;
					}
					if (selectedIds.length === 0) {
						continue;
					}

					const composerKeys = [
						'composer.composerData',
						'cursor.composerData',
						'cursorComposerData',
						'workbench.panel.composer'
					];

					let composerData = null;
					for (const key of composerKeys) {
						const result = await db.get(`
							SELECT value FROM ItemTable 
							WHERE [key] = ?
						`, [key]);

						if (result?.value) {
							try {
								const parsed = JSON.parse(result.value);
								if (parsed.allComposers) {
									parsed.allComposers = parsed.allComposers.filter(
										(composer: any) => selectedIds.includes(composer.composerId)
									);
									composerData = parsed;
									break;
								}
							} catch (e) {
								continue;
							}
						}
					}

					const globalStoragePaths = [
						path.join(workspacePath, '..', 'globalStorage', 'state.vscdb'),
						path.join(vscode.env.appRoot, '..', 'User', 'globalStorage', 'state.vscdb')
					];

					if (composerData?.allComposers?.length > 0) {
						
						for (const globalDbPath of globalStoragePaths) {
							if (!fs.existsSync(globalDbPath)) {
								;
								continue;
							}

							try {
								const globalDb = await open({
									filename: globalDbPath,
									driver: sqlite3.Database
								});

								try {
									const tables = ['cursorDiskKV', 'ItemTable'];
									let foundData = false;

									for (const table of tables) {
										try {
											const keys = composerData.allComposers.map((it: { composerId: string }) => `composerData:${it.composerId}`);
											const placeholders = keys.map(() => '?').join(',');

											const composersBodyResult = await globalDb.all<GlobalStorageResult[]>(`
												SELECT [key], value FROM ${table}
												WHERE [key] IN (${placeholders})
											`, keys);

											if (composersBodyResult?.length > 0) {
												
												composerData.allComposers = await Promise.all(composerData.allComposers
													.map(async (composer: ComposerData['allComposers'][0]) => {
														;
														const composerContent = composersBodyResult.find(
															r => r.key === `composerData:${composer.composerId}`
														);

														if (composerContent) {
															try {
																const content = JSON.parse(composerContent.value);
																const conversation = processConversation(content, composer);
																return {
																	...composer,
																	conversation
																};
															} catch (e) {
																;
																return composer;
															}
														}
														return composer;
													}));
											
												foundData = true;
												break;
											}
										} catch (e) {
											continue;
										}
									}

									if (foundData) break;
								} finally {
									await globalDb.close();
								}
							} catch (e) {
								;
								continue;
							}
						}

						checkForNewMessages({
							id: workspaceId,
							path: dbPath,
							composerData,
							chatCount: 0,
							composerCount: composerData.allComposers.length
						});
					}
				} finally {
					await db.close();
				}
			}
		} catch (error) {
			console.error('Error checking messages:', error);
		}
	}, currentSettings.checkInterval);
}

function checkForNewMessages(workspace: Workspace) {
	if (!workspace.composerData?.allComposers) return false;
	const selectedComposerIds = workspace.composerData.selectedComposerIds || [];
	const activeComposers = workspace.composerData.allComposers.filter((composer: ComposerData['allComposers'][0]) => {
		const isSelected = selectedComposerIds.includes(composer.composerId);
		const hasName = composer.name && composer.name !== 'New Chat';
		return isSelected || hasName;
	});

	let hasNewMessages = false;
	const chatsWithNewMessages = new Set<string>();
	activeComposers.forEach((composer: ComposerData['allComposers'][0]) => {
		const conversation = Array.isArray(composer.conversation) ? composer.conversation : [];

		let latestTimestamp = composer.lastUpdatedAt || 0;
		if (conversation.length > 0) {
			conversation.forEach((msg: Message) => {
				if (msg.timestamp && msg.timestamp > latestTimestamp) {
					latestTimestamp = msg.timestamp;
				}
			});
		}

		const currentState = {
			composerId: composer.composerId,
			lastMessageCount: conversation.length,
			lastMessageTimestamp: latestTimestamp
		};

		const previousState = messageStates.get(composer.composerId);
		
		if (previousState) {
			if (currentState.lastMessageCount > previousState.lastMessageCount ||
				currentState.lastMessageTimestamp > previousState.lastMessageTimestamp) {
				
				const newMessagesCount = currentState.lastMessageCount - previousState.lastMessageCount;
				hasNewMessages = true;
				
				if (newMessagesCount > 0) {
					;
					
					const newMessages = conversation.slice(-newMessagesCount);

					let hasNewerAssistantMessages = false;
					newMessages.forEach((msg: Message) => {
						if (msg.type === 'assistant' && msg.timestamp && msg.timestamp > previousState.lastMessageTimestamp) {
							hasNewerAssistantMessages = true;
							;
						} else {
							;
						}
					});

					;

					if (hasNewerAssistantMessages) {
						chatsWithNewMessages.add(composer.name || 'Unnamed Chat');
					}
				}
			}
		} else {
			;
		}

		messageStates.set(composer.composerId, currentState);
	});

	if (chatsWithNewMessages.size > 0) {
		;
		chatsWithNewMessages.forEach(chatName => {
			notifyWebviewsOfNewMessage(chatName);
		});
	}

	return hasNewMessages;
}

function notifyWebviewsOfNewMessage(chatName: string) {
	vscode.window.showInformationMessage(`New messages in "${chatName}"`);
	
	const activeWebviews = (vscode.window as any)._activeWebviewPanels || [];
	
	if (activeWebviews.length > 0) {
		;
		
		for (const panel of activeWebviews) {
			if (panel.viewType === 'cursorChats' || panel.viewType === 'workspaceDetail') {
				try {
					panel.webview.postMessage({ 
						command: 'newMessagesAvailable',
						data: { chatName }
					});
					;
				} catch (error) {
					;
				}
			}
		}
	} else {
		;
	}
}

async function getCurrentCursorWorkspace(): Promise<Array<{ workspaceId: string; workspacePath: string }>> {
	try {
		const currentWorkspaces = vscode.workspace.workspaceFolders;
		if (!currentWorkspaces || currentWorkspaces.length === 0) {
			;
			return [];
		}

		const platform = process.platform;
		const homeDir = os.homedir();
		let workspacePath;
		
		switch (platform) {
			case 'win32':
				workspacePath = path.join(process.env.APPDATA || '', 'Cursor', 'User', 'workspaceStorage');
				break;
			case 'darwin':
				workspacePath = path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage');
				break;
			case 'linux':
				workspacePath = path.join(homeDir, '.config', 'Cursor', 'User', 'workspaceStorage');
				break;
			default:
				throw new Error('Unsupported operating system');
		}

		const entries = await fs.promises.readdir(workspacePath, { withFileTypes: true });
		
		const foundWorkspaces: Array<{ workspaceId: string; workspacePath: string }> = [];

		for (const workspace of currentWorkspaces) {
			const currentProjectName = path.basename(workspace.uri.fsPath);
			;

			for (const entry of entries) {
				if (!entry.isDirectory()) continue;

				const workspaceJsonPath = path.join(workspacePath, entry.name, 'workspace.json');
				if (!fs.existsSync(workspaceJsonPath)) continue;

				try {
					const workspaceData = JSON.parse(await fs.promises.readFile(workspaceJsonPath, 'utf-8'));
					const projectPath = workspaceData.folder;
					const projectName = projectPath ? path.basename(projectPath.replace(/^file:\/\/\/?/, '')) : '';

					if (projectName === currentProjectName) {
						;
						foundWorkspaces.push({
							workspaceId: entry.name,
							workspacePath: workspacePath
						});
					}
				} catch (error) {
					continue;
				}
			}
		}
		
		if (foundWorkspaces.length === 0) {
			;
		} else {
			;
		}
		
		return foundWorkspaces;
	} catch (error) {
		;
		return [];
	}
}
