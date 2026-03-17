# Workspace Viewer

[한국어](README_KR.md)

A Jupyter Notebook extension that adds a **Notion-like file browser** and **terminal management UI** — designed as a lightweight, self-hosted alternative to Claude Code Remote.

## Features

- **File Browser**: Navigate your workspace with a clean, Notion-style interface with syntax highlighting
- **Terminal Manager**: Create, rename, switch between, and shut down multiple terminal sessions
- **Claude Code Ready**: Run multiple Claude Code instances simultaneously in separate terminals
- **Zero Config**: Automatically uses Jupyter's `notebook_dir` as the workspace path

## Quick Start

```bash
# Clone the repository
git clone https://github.com/Harry24k/workspace-viewer.git
cd workspace-viewer

# Install dependencies (includes Jupyter Notebook 6 and Tornado)
pip install -r requirements.txt

# Register the extension
jupyter serverextension enable --py jupyter_ext --sys-prefix

# Start Jupyter Notebook
jupyter notebook
```

Then visit `http://localhost:8888/workspace-viewer` in your browser.

## Requirements

- Python 3
- Jupyter Notebook 6.x
- Tornado

All dependencies are managed via `requirements.txt`.

## Blog Post

For a detailed setup guide and usage walkthrough, see the blog post:

- **English**: [Workspace Viewer: A Self-Hosted Claude Code Remote Alternative via Jupyter Notebook](https://harry24k.github.io/tool/2026/03/17/workspace-viewer-eng.html)
- **한국어**: [Workspace Viewer: Jupyter Notebook를 활용한 셀프 호스팅 Claude Code Remote 대안](https://harry24k.github.io/tool/2026/03/17/workspace-viewer.html)

## License

See [LICENSE](LICENSE) for details.
