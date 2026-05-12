import { DoctorCheck } from "./contracts.js";

/** Reports whether cdx-claude v0.1.0 supports autonomous Claude sandbox jobs on this platform. */
export function sandboxPlatformSupported(): boolean {
  return currentPlatform() === "darwin";
}

/** Builds the doctor row for Claude Code native sandbox support. */
export function sandboxCheck(): DoctorCheck {
  const supported = sandboxPlatformSupported();
  return {
    ok: supported,
    summary: supported
      ? "Claude Code native sandbox is configured fail-closed; run sandbox canary for live proof"
      : "patch_autonomous is unsupported on this platform in cdx-claude v0.1.0",
    details: {
      patch_autonomous_supported: supported,
      platform: currentPlatform(),
      implementation: "claude-code-native-sandbox",
      fail_if_unavailable: true,
      allow_unsandboxed_commands: false,
      canary_proof: "not_run_by_doctor"
    }
  };
}

function currentPlatform(): NodeJS.Platform | string {
  return process.env.CDX_CLAUDE_TEST_PLATFORM ?? process.platform;
}
