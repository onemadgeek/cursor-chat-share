# Cursor Chat Share

A Cursor extension that allows you to view and share your chat conversations.

## Features

- 🔍 View all your chat conversations in Cursor
- 📋 Export chats to markdown files
- 📎 Copy chat content to clipboard

## Why Use This Extension?

- **Documentation**: Save important AI-assisted coding sessions
- **Collaboration**: Share your Cursor conversations with team members
- **Backup**: Keep a record of your AI interactions

## Installation

### Manual Installation (Using VSIX file)
1. Clone this repository:
   ```bash
   git clone https://github.com/onemadgeek/cursor-chat-share.git
   cd cursor-chat-share
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the extension:
   ```bash
   npm run package
   ```

4. Install the extension:
   - In Cursor IDE, go to the Extensions view
   - Click the "..." menu in the top right
   - Select "Install from VSIX..."
   - Navigate to the `cursor-chat-share-0.0.1.vsix` file in the project directory
   - Click Install

## Usage

- Use the "Connect: Show All Cursor Chats" command to view your conversations
- Click the share icon in the status bar to export a chat
- Select a chat to view its full conversation history


## License

MIT License

## Author

[onemadgeek](https://github.com/onemadgeek) 