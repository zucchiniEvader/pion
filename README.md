<div align="center">
  <img src="assets/pion-logo.png" alt="Pion" width="96" />
  <h1>Pion</h1>
  <p><strong>A native desktop GUI for PI — Native, focused, and ready out of the box.</strong></p>
  <p>
    <a href="README.md">English</a> | <a href="README_CN.md">简体中文</a>
  </p>
  <p>
    <img alt="ci" src="https://github.com/zucchiniEvader/pion/actions/workflows/ci.yml/badge.svg" />
    <img alt="platform" src="https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon)-black" />
    <img alt="license" src="https://img.shields.io/badge/license-MIT-blue" />
    <img alt="status" src="https://img.shields.io/badge/remote%20runtime-beta-orange" />
  </p>
</div>

Pion is a dedicated local desktop client for [PI](https://pi.dev). Designed to work directly alongside the official Agent Runtime, Pion focuses on delivering an intuitive, efficient desktop experience for session management and real-time interaction.

- **Official RPC-Driven**: Communicates via standard `pi --mode rpc` process pipelines, preserving the official runtime behavior and execution environment.
- **Seamless Environment Reuse**: Directly inherits your existing local PI configuration, community extensions, prompt templates, and skills — sharing the exact same environment with the CLI.
- **Single Source of Truth**: Uses PI's session JSONL directly as the conversation history truth source, keeping all conversation data cleanly inside your local PI setup.

<div align="center">
  <img src="assets/screenshot.png" alt="Pion Interface: sidebar projects & sessions, main conversation stream, input box and model picker" width="880" />
</div>

## Features

- **Multi-Session Workspace**: Fast switching between projects and sessions with an automated pool of up to 4 runtimes; supports streaming output, thought process visibility, expandable tool call cards (arguments and results), clipboard image pasting, and in-flight steering / aborting.
- **Native Extension Interactions**: Renders interactive prompts from extensions (Select, Confirm, Input, Notify) as native UI cards for direct point-and-click action.
- **Slash Commands & Auto-completion**: Type `/` to instantly access installed extension commands, prompt templates, and skills with clear provenance tags.
- **Model & Reasoning Control**: Automatically reads `~/.pi/agent/models.json`, allowing instant model switching and thinking level adjustments per session.
- **Git & Worktree Integration**: Visual overview of branches and worktrees, one-click creation of dedicated worktrees, and quick opening in Finder, Ghostty, or VS Code.
- **Settings & Environment Management**: Switch between English/Chinese and dark/light themes, check and update PI and extensions, and monitor runtime statuses.
- **Session Crash Resilience**: Provides one-click reconnection and recovery if an underlying runtime process terminates unexpectedly.

## Community Extension Support

Pion automatically detects installed extensions in your local environment and renders tailored UI components:

| Extension | Integration in Pion |
| --- | --- |
| `@juicesharp/rpiv-todo` | Persistent task panel above the input area, dynamically syncing session todo snapshots and progress |
| `@narumitw/pi-plan-mode` | Dedicated interactive cards for `plan_mode_question` and `plan_mode_complete`, with clear `/plan` workflow feedback |
| `@narumitw/pi-goal` | Full support for the `/goal` command and `goal_complete` / `goal_blocked` / `goal_wait` lifecycle transitions |
| Other Extensions | Universal tool cards with collapsible argument/result views, faithfully presenting all execution events |

## Task Kanban (Optional)

A lightweight execution loop from idea to completion: **Create Card → Dispatch to Agent → Agent Executes & Reports → Review Phase → Human Verification (Done / Reopen)**.

- **Event-Driven Storage**: State is persisted in your project's own `.pion/kanban/events.jsonl`, allowing both CLI `pi` and the GUI to collaborate on the same board.
- **On-Demand Usage**: Only writes logs when the Kanban feature is actively used; the board view can be toggled on or off from the sidebar at any time.

## Remote Runtime (Beta)

Connect remote machines running `pion-daemon` into your desktop Pion instance, enjoying the same multi-session, streaming, and Kanban experience as local projects.

- Connect via pairing codes, token authentication, or local network direct connection.
- Supports QR code pairing for mobile clients (companion iOS client in development).

## Roadmap

- **File Diff Viewer**: Inspect Agent code modifications directly within the GUI.
- **Integrated Terminal Panel**: Built-in terminal running independently from the PI RPC communication channel.

## Getting Started

### Prerequisites

- macOS (Apple Silicon)
- Node.js 18+
- Installed and configured [`pi`](https://pi.dev) CLI

### Installation & Run

```bash
# Clone the repository
git clone https://github.com/zucchiniEvader/pion.git
cd pion

# Install dependencies
npm install

# Start development mode
npm run dev

# Build DMG package
npm run dist

# Quick unpackaged build (macOS .app)
npm run dist:dir
```

On first launch, Pion automatically detects your local PI environment. Simply select a project folder to start.

## Design Principles

- **Dedicated to the PI Ecosystem**: Focused on building a deeply tailored desktop experience for PI while keeping the application lightweight and clean.
- **Standard Protocol Communication**: Built strictly on the official `pi --mode rpc` JSONL pipe protocol for maximum stability and transparent communication.
- **Explicit Authorization**: Preserves explicit user consent and clear safety boundaries for all execution privileges and resource access.
- **Local & Self-Hosted First**: All data storage and communication remain entirely under user control, safeguarding project source code and conversational privacy.

## License

Licensed under the [MIT](LICENSE) License. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [SECURITY.md](SECURITY.md) for security policies.
