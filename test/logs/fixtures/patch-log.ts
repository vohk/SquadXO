// Sanitized production log samples captured on 2026-10-01; only EOS and steam IDs were observed.
export const captureLines = [
  '[2026.10.01-18.07.17:659][498]LogSquad: Capture zone Walled Courts was fully captured by team 1',
  '[2026.10.01-18.14.40:664][752]LogSquad: Capture zone Walled Courts was neutralized by team 2 (was owned by team 1)',
  '[2026.10.01-18.15.58:674][727]LogSquad: Capture zone Walled Courts was fully captured by team 2',
  '[2026.10.01-18.45.30:687][732]LogSquad: Capture zone Walled Courts was neutralized by team 1 (was owned by team 2)',
  '[2026.10.01-18.46.49:689][770]LogSquad: Capture zone Walled Courts was fully captured by team 1'
];
export const markerLines = [
  '[2026.10.01-18.25.56:734][867]LogSquad: Player Sample Ω (Team: 2; ID: EOS: 11111111111111111111111111111111 steam: 76561198000000001) placed a new map marker for team 2 : Type: BP_MapMarker_POI ; Location: -4907.00000, 16010.00000, -13496.00000',
  '[2026.10.01-18.25.57:941][944]LogSquad: Player Sample Ω (Team: 2; ID: EOS: 11111111111111111111111111111111 steam: 76561198000000001) placed a new map marker for team 2 : Type: BP_MapMarker_Action_ObserveSL ; Location: -5380.00000, 15858.00000, -13284.00000',
  '[2026.10.01-18.26.06:565][494]LogSquad: Player Sample Ω (Team: 2; ID: EOS: 11111111111111111111111111111111 steam: 76561198000000001) placed a new map marker for team 2 : Type: BP_MapMarker_Action_AttackSL ; Location: -1328.00000, 16005.00000, -13486.00000',
  '[2026.10.01-18.26.10:344][735]LogSquad: Player Sample Ω (Team: 2; ID: EOS: 11111111111111111111111111111111 steam: 76561198000000001) placed a new map marker for team 2 : Type: BP_MapMarker_GridHeader_Spotted_Infantry ; Location: -2426.00000, 16432.00000, -13372.00000',
  '[2026.10.01-18.26.17:385][184]LogSquad: Player Sample Ω (Team: 2; ID: EOS: 11111111111111111111111111111111 steam: 76561198000000001) placed a new map marker for team 2 : Type: BP_MapMarker_POI ; Location: -1063.00000, 15295.00000, -13488.00000',
  '[2026.10.01-18.26.19:674][330]LogSquad: Player Sample Ω (Team: 2; ID: EOS: 11111111111111111111111111111111 steam: 76561198000000001) placed a new map marker for team 2 : Type: BP_MapMarker_Action_MoveSL ; Location: 4374.00000, 11743.00000, -13606.00000'
];
export const deployableLines = [
  '[2026.10.01-17.43.22:615][  0]LogSquad: Deployable Team1PreplacedFOBRadio spawned for team 1 at location {15160.00000, -2150.00000, -12980.00000}',
  '[2026.10.01-17.43.24:657][108]LogSquad: Deployable AmmoCrate_WPMC spawned for team 1 at location {54010.85938, 5350.62500, -13486.72168}',
  '[2026.10.01-17.43.24:660][108]LogSquad: Deployable AmmoCrateActor_GEN_VARIABLE_BP_Ammocrate_WPMC_C_CAT_42 spawned for team 0 at location {14463.67622, -2303.92237, -13016.24858}'
];
export const permissionLines = [
  '[2026.10.01-18.11.06:046][ 65]LogSquadCommon: SQCommonStatics Check Permissions succeeded, UniqueId:11111111111111111111111111111111',
  '[2026.10.01-18.03.59:654][870]LogSquadCommon: SQCommonStatics Check Permissions, UniqueId:11111111111111111111111111111111'
];
export const existingLines = [
  '[2026.10.01-18.04.23:910][417]LogSquad: PostLogin: NewPlayer: BP_PlayerController_C /Game/Maps/Sumari/Gameplay_Layers/Sumari_Seed_v1.Sumari_Seed_v1:PersistentLevel.BP_PlayerController_C_42 (IP: 192.0.2.1 | Online IDs: EOS: 11111111111111111111111111111111 steam: 76561198000000001)',
  '[2026.10.01-18.11.41:276][310]LogSquadTrace: [DedicatedServer]OnPossess(): PC=Sample Victim (Online IDs: EOS: 11111111111111111111111111111111 steam: 76561198000000001) Pawn=BP_Soldiers_WPMC_Rifleman_01_C_42 FullPath=BP_Soldiers_WPMC_Rifleman_01_C /Game/Maps/Sumari/Gameplay_Layers/Sumari_Seed_v1.Sumari_Seed_v1:PersistentLevel.BP_Soldiers_WPMC_Rifleman_01_C_42',
  '[2026.10.01-18.12.38:756][977]LogSquadTrace: [DedicatedServer]OnUnPossess(): PC=Sample Victim (Online IDs: EOS: 11111111111111111111111111111111 steam: 76561198000000001) current health value 0.000000',
  '[2026.10.01-18.13.27:661][ 96]LogSquad: Player:  Sample Victim ActualDamage=87.000000 from nullptr (Online IDs: INVALID | Player Controller ID: None)caused by BP_Projectile_7_62mm_C_42',
  '[2026.10.01-18.16.36:823][160]LogSquad: Player:  Sample Victim ActualDamage=99.563721 from Sample Attacker (Online IDs: EOS: 11111111111111111111111111111111 steam: 76561198000000001 | Player Controller ID: BP_PlayerController_C_42)caused by BP_FNFAL_GL_HEAT_Rifle_C_42',
  '[2026.10.01-18.13.34:873][556]LogSquadTrace: [DedicatedServer]Wound(): Player:  Sample Victim KillingDamage=87.000000 from nullptr (Online IDs: INVALID | Controller ID: None) caused by BP_Projectile_7_62mm_C_42',
  '[2026.10.01-18.16.38:266][252]LogSquadTrace: [DedicatedServer]Wound(): Player:  Sample Victim KillingDamage=0.000000 from BP_PlayerController_C_42 (Online IDs: EOS: 11111111111111111111111111111111 steam: 76561198000000001 | Controller ID: BP_PlayerController_C_42) caused by BP_Soldiers_WPMC_Rifleman_03_C_42',
  '[2026.10.01-18.12.38:740][976]LogSquadTrace: [DedicatedServer]Die(): Player:  Sample Victim KillingDamage=100.000000 from BP_PlayerController_C_42 (Online IDs: EOS: 11111111111111111111111111111111 steam: 76561198000000001 | Contoller ID: BP_PlayerController_C_42) caused by nullptr',
  '[2026.10.01-18.13.36:219][642]LogSquadTrace: [DedicatedServer]Die(): Player:  Sample Victim KillingDamage=-300.000000 from nullptr (Online IDs: INVALID | Contoller ID: None) caused by BP_Soldiers_WPMC_Rifleman_03_C_42'
];
