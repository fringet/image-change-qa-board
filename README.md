# Commerce Image QA board — install

A local, loopback-only review app for e-commerce imagery: before/after comparison,
product-identity anchors, revision history, and a decision handoff back to the agent.

## Install

    mkdir -p ~/.codex/skills
    tar -xzf image-change-qa-board.tgz -C ~/.codex/skills

To use it from Claude Code as well:

    mkdir -p ~/.claude/skills
    ln -s ~/.codex/skills/image-change-qa-board ~/.claude/skills/image-change-qa-board

## Requirements

Node 18+ and the `sharp` image library. The launcher prefers the Codex bundled runtime
and falls back to whatever `node` is on PATH. If `sharp` is not resolvable there:

    npm install --global sharp
    export COMMERCE_QA_NODE_MODULES="$(npm root -g)"

## Check it works

    ~/.codex/skills/image-change-qa-board/scripts/commerce-qa help

## Where things live

Nothing is stored inside the skill.

- Per project: `<project>/.image-change-qa/` — manifest, product truth, review state,
  submissions, cached thumbnails.
- Shared service registry: `~/Documents/Codex/.commerce-qa/`
  (override with `COMMERCE_QA_STATE_DIR`).

The service binds only to 127.0.0.1 and starts on demand.
