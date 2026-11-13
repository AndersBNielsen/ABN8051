# ABN8051 rev 0.2 — work brief (from Anders, 2026-11-13)

> Add a MIC5504-3.3 as alternate regulator to the ST, also add the narrow dip28 as alternate pinout for the SRAMs on top of the wide dip. Also add the button I have 1500 of on the shop as alternate pinout for the buttons - I want the footprints to overlap and still work electrically. Silk can indicate. Please put solder jumpers on the bottom side - makes them easier to work and they can be close to the text that describes them. Do it in small steps so progress isn't lost if you run out of allowance. If you do finish the above you can start routing the PCB.

## Rules
- Work in `~/ai/ABN8051` (Git, branch `main`). Commit after **every** step below with a clear message; tick the step in this file in the same commit. Do not push.
- Before the first edit, check `git status` and whether `hardware/ABN8051.kicad_pcb` / `.kicad_sch` differ from what `hardware/tools/pcbgen.py` / `design.py` produce (Anders may have edited in KiCad). If the KiCad files were edited by hand, edit them directly (pcbnew Python / S-expression parser with paren counting) and never re-run the generators over them. If untouched since `00cd9f0`, the generators may be extended and re-run, and must be copied back into `hardware/tools/`.
- After every step: ERC (`kicad-cli sch erc`), netlist vs. board pad nets, DRC (`kicad-cli pcb drc`, refill zones), render. Report new violations by type; "unconnected" is expected until routing.
- Verify every new pinout against the manufacturer datasheet and the KiCad footprint pad numbers before wiring.
- Skills: read `~/.openclaw/agents/main/agent/workshop-skills/pcb-routing-validation/SKILL.md` (and its references) first.

## Steps
- [ ] 1. **MIC5504-3.3YM5 alternate to U9 (KF33BD, SO-8).** SOT-23-5, LCSC C3021093 (used on 65uino). Confirm the pinout from the Microchip datasheet (expected 1 VIN, 2 GND, 3 EN, 4 NC, 5 VOUT). Add as a separate DNP-able footprint (e.g. U11) sharing +5V/GND/+3V3; EN to VIN (or +5V). Place it adjacent to/overlapping U9 so either can be fitted; mark mutually exclusive in silk ("fit U9 or U11"). Check output-cap requirements for both (KF33 needs ESR 0.1–10 Ω tantalum; MIC5504 is MLCC-stable, 1 µF).
- [ ] 2. **Narrow DIP-28 (7.62 mm) for U4/U5 SRAMs**, overlapping the wide 15.24 mm footprint, same pin-1 position, both electrically identical (e.g. add U4N/U5N as DNP alternates on the same nets, or one combined footprint). Board must pass DRC with the overlap intentional (document any intentional courtyard exclusions). Silk: "300/600 mil".
- [ ] 3. **FC-003D-5.0 3×6 mm SMD tactile switch** (iMania product 7342, 1500 in stock; check its datasheet/land pattern and pin connection) as alternate for SW2/SW3/SW4 (TL3342 now), overlapping footprints, both wired correctly. Silk indicates.
- [ ] 4. **Move solder jumpers JP2–JP6 to the bottom (B.Cu)** next to the back-silk legend that describes them; update the back-silk text so each jumper is labelled where it sits. JP1 (ROM pin-1 header) stays a top-side 3-pin header unless there is a clear reason.
- [ ] 5. Update `hardware/README.md`, BOM export, `ABN8051.pdf`, `ABN8051-floorplan.png`.
- [ ] 6. Only if 1–5 are done: start routing (keep a copy of the unrouted board first; prefer Freerouting per the skill). Commit routing progress in chunks and report remaining unconnected count + DRC.

## Progress log
(append one line per session: date/time, steps done, commit hash, anything blocked)
