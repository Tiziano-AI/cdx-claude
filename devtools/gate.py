#!/usr/bin/env python3
"""Repository gate for cdx-claude.

Runs the canonical TypeScript verification stack and regenerates deterministic artifacts.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def main() -> int:
    repo = Path(__file__).resolve().parents[1]
    command = ["pnpm", "verify"]
    result = subprocess.run(command, cwd=repo, check=False)
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
