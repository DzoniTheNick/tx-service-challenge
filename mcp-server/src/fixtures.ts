/**
 * Fictional "Acme d.o.o." fixtures for the MCP server (CONTEXT.md §5).
 * Bundled as data (Workers have no filesystem). Policies carry frontmatter-style
 * metadata; equipment profiles match the pinned EquipmentProfile contract.
 */

export interface Policy {
  readonly id: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly version: string;
  readonly lastUpdated: string;
  readonly body: string;
}

export const POLICIES: readonly Policy[] = [
  {
    id: "remote-work",
    title: "Remote Work Policy",
    tags: ["remote", "work-from-home", "hybrid", "wfh"],
    version: "2.1",
    lastUpdated: "2026-03-01",
    body:
      "Employees may work remotely up to 3 days per week with manager approval. " +
      "Core collaboration hours are 10:00–15:00 CET. Remote workers must use the " +
      "company VPN for access to internal systems and keep equipment physically secure."
  },
  {
    id: "annual-leave",
    title: "Annual Leave Policy",
    tags: ["leave", "vacation", "pto", "holiday", "time-off"],
    version: "3.0",
    lastUpdated: "2026-01-15",
    body:
      "Full-time employees accrue 25 paid leave days per year. Requests are submitted " +
      "through the HR portal at least 2 weeks in advance and require manager approval. " +
      "Up to 5 unused days may be carried into the next year; the rest are forfeited."
  },
  {
    id: "equipment",
    title: "Equipment & Hardware Policy",
    tags: ["equipment", "hardware", "laptop", "upgrade", "device"],
    version: "1.4",
    lastUpdated: "2026-05-20",
    body:
      "Standard hardware is issued per role profile. Laptops are refreshed every 3 years. " +
      "Upgrades outside the refresh cycle require a documented business justification and " +
      "manager approval, and must stay within the per-role equipment budget."
  },
  {
    id: "onboarding",
    title: "Onboarding Policy",
    tags: ["onboarding", "new-hire", "setup", "first-day"],
    version: "1.1",
    lastUpdated: "2026-02-10",
    body:
      "New hires receive their role equipment profile on day one. IT provisions accounts, " +
      "VPN access and the standard software set before the start date. HR schedules " +
      "orientation within the first week."
  }
];

export interface EquipmentProfileFixture {
  readonly role: string;
  readonly laptop: { readonly model: string; readonly specs: string };
  readonly accessories: readonly string[];
  readonly software: readonly string[];
  readonly source: { readonly policyId: string; readonly version: string };
}

export const EQUIPMENT_PROFILES: Readonly<
  Record<string, EquipmentProfileFixture>
> = {
  engineer: {
    role: "engineer",
    laptop: { model: "Dell XPS 15", specs: "32GB RAM, 1TB SSD, i7" },
    accessories: ["27-inch monitor", "mechanical keyboard", "docking station"],
    software: ["VS Code", "Docker", "Slack", "company VPN"],
    source: { policyId: "equipment", version: "1.4" }
  },
  designer: {
    role: "designer",
    laptop: { model: "MacBook Pro 16", specs: "36GB RAM, 1TB SSD, M-series" },
    accessories: ["color-calibrated monitor", "drawing tablet"],
    software: ["Figma", "Adobe CC", "Slack", "company VPN"],
    source: { policyId: "equipment", version: "1.4" }
  },
  sales: {
    role: "sales",
    laptop: { model: "Lenovo ThinkPad X1", specs: "16GB RAM, 512GB SSD, i5" },
    accessories: ["headset", "portable monitor"],
    software: ["CRM", "Slack", "company VPN"],
    source: { policyId: "equipment", version: "1.4" }
  }
};

export interface KbArticle {
  readonly id: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly body: string;
}

export const IT_KB: readonly KbArticle[] = [
  {
    id: "kb-vpn",
    title: "VPN won't connect",
    tags: ["vpn", "network", "remote", "connection"],
    body:
      "1) Confirm internet access. 2) Restart the VPN client. 3) Verify your " +
      "credentials have not expired. 4) If it still fails, check the service status " +
      "and contact IT with the error code."
  },
  {
    id: "kb-password",
    title: "Password reset and lockouts",
    tags: ["password", "login", "account", "lockout"],
    body:
      "Accounts lock after 5 failed attempts for 15 minutes. Use the self-service " +
      "portal to reset. If you are an admin performing a reset for a user, confirm " +
      "identity first; the user must change the temporary password at next sign-in."
  },
  {
    id: "kb-wifi",
    title: "Office Wi-Fi is slow or dropping",
    tags: ["wifi", "network", "slow", "office"],
    body:
      "Forget and rejoin the 'TX-Service' network, move closer to an access point, " +
      "and avoid the guest network for work traffic. Persistent issues: report the " +
      "floor and access-point name to IT."
  },
  {
    id: "kb-printer",
    title: "Printer offline",
    tags: ["printer", "hardware", "office"],
    body:
      "Check the printer is powered and on the network, clear any paper jam, and " +
      "re-add the printer queue. The 3rd-floor printer is a known recurring issue " +
      "tracked by facilities."
  }
];
