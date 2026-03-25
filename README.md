# Claude Notebook

[한국어](README_KR.md)

A Jupyter Notebook extension that adds a **Notion-like file browser** and **terminal management UI** — designed as a lightweight, self-hosted alternative to Claude Code Remote.

## Screenshots

#### File Browser (Desktop / Mobile)

<p>
  <img src="images/viewer_desktop.png" width="600">
  <img src="images/viewer_mobile.png" width="200">
</p>

- Notion-style grid view with folder/file icons
- Sidebar tree navigation with expandable folders
- Responsive layout — collapsible sidebar on mobile with hamburger menu

#### Terminal Manager (Desktop / Mobile)

<p>
  <img src="images/terminal_desktop.png" width="600">
  <img src="images/terminal_mobile.png" width="200">
</p>

- Multi-terminal sidebar with status indicators
- xterm.js-powered terminal with VS Code dark theme
- iMessage-style chat view for conversational interaction with Claude Code
- File upload and command input bar with drag-resize

## Features

- **File Browser**: Navigate your workspace with a Notion-style interface — syntax highlighting, Markdown rendering, image preview, and inline editing
- **CSV Viewer**: Interactive table with column sorting, filtering, resizable columns, row coloring, and cell copy
- **Terminal Manager**: Create, rename, configure, and switch between multiple persistent terminal sessions
- **Chat Mode**: iMessage-style chat view that renders terminal output as conversation bubbles with ANSI color support
- **File Upload**: Drag-and-drop file/folder upload with automatic filename collision handling
- **Server Config**: Terminal names, startup commands, chat mode preference, and CSV settings persist on the server
- **Mobile Ready**: Fully responsive design with touch-optimized UI, collapsible sidebar, and terminal copy support
- **Claude Code Ready**: Run multiple Claude Code instances simultaneously in separate terminals
- **Zero Config**: Automatically uses Jupyter's `notebook_dir` as the workspace path

## Quick Start

```bash
# Clone the repository
git clone https://github.com/Harry24k/claude-notebook.git
cd claude-notebook

# Install dependencies (includes Jupyter Notebook 6 and Tornado)
pip install -r requirements.txt

# Register the extension
jupyter serverextension enable --py jupyter_ext --sys-prefix

# Start Jupyter Notebook
jupyter notebook
```

Then visit `http://localhost:8888/claude-notebook` in your browser.

## Requirements

- Python 3
- Jupyter Notebook 6.x
- Tornado

All dependencies are managed via `requirements.txt`.

## Blog Post

For a detailed setup guide and usage walkthrough, see the blog post:

- **English**: [Claude Notebook: A Self-Hosted Claude Code Remote Alternative via Jupyter Notebook](https://trustworthyai.co.kr/article/2026/claude-notebook-eng/)
- **한국어**: [Claude Notebook: Jupyter Notebook를 활용한 셀프 호스팅 Claude Code Remote 대안](https://trustworthyai.co.kr/article/2026/claude-notebook/)

## License

See [LICENSE](LICENSE) for details.
