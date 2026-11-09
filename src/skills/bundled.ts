/**
 * Bundled skills — the documented fallback (CONTEXT.md §6) used when the KV
 * `SKILLS` namespace is unavailable. The SKILL.md files remain the single source;
 * they are imported raw and parsed at module load so there is no second copy to
 * drift. KV (seeded from the same files) is canonical at runtime.
 */

import troubleshootingMd from "../../skills/troubleshooting/SKILL.md?raw";
import deviceSetupMd from "../../skills/device-setup/SKILL.md?raw";
import leaveRequestMd from "../../skills/leave-request-process/SKILL.md?raw";
import { parseSkill, type Skill } from "./loader";

export const BUNDLED_SKILLS: readonly Skill[] = [
  parseSkill(troubleshootingMd),
  parseSkill(deviceSetupMd),
  parseSkill(leaveRequestMd)
];
