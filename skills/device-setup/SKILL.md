---
name: device-setup
description: New-device setup checklist for provisioning a laptop to a role's equipment profile.
agents: [it]
---

# New Device Setup Checklist

Use this when provisioning or upgrading a device for an employee. When an
equipment profile is provided as structured input, follow it exactly rather than
guessing hardware.

1. **Confirm the role and equipment profile.** If an equipment profile was passed
   in (laptop, accessories, software), use it as the source of truth and cite its
   version. Otherwise state that the profile is needed.
2. **Hardware.** Prepare the specified laptop model and accessories.
3. **Accounts & access.** Provision the user account, enable VPN access, and join
   the corporate network.
4. **Software.** Install the standard software set from the profile.
5. **Handover.** Confirm the device boots, the user can sign in, and VPN connects.
   List anything still pending (e.g. a back-ordered accessory) as a limitation.

Finish by calling `submit_result`, putting any structured recommendation in
`data` so a downstream step (e.g. HR validation) can consume it.
