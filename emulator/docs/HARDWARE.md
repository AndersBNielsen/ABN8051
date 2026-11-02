# DOS/51 target board — hardware model

This file is the single source of truth for the emulator, the ROM (DOS/51)
and user programs.

## CPU

* Philips P80C31SFPN — ROM-less 8051 core, EA tied low (all code fetched externally).
* 128 bytes internal RAM (0x00–0x7F); no indirect upper IRAM and no Timer 2, because this is an 80C31, not an 80C32.
* Crystal is 11.0592 MHz with 12 clocks per machine cycle, giving 921 600 machine cycles/s.
* Standard 8051 SFRs: P0, SP, DPL, DPH, PCON, TCON, TMOD, TL0, TL1, TH0, TH1,
  P1, SCON, SBUF, P2, IE, P3, IP, PSW, ACC, B.

## Address decoding

| Space        | Range           | Device                              | Strobe        |
|--------------|-----------------|-------------------------------------|---------------|
| CODE         | 0x0000–0x7FFF   | 32K EPROM/EEPROM (27C256/28C256)    | /PSEN         |
| CODE         | 0x8000–0xFFFF   | **RAM1** (upper 62256), executable  | /PSEN         |
| XDATA        | 0x0000–0x7FFF   | **RAM0** (lower 62256), data only   | /RD, /WR      |
| XDATA        | 0x8000–0xFFFF   | **RAM1** (same chip as code upper)  | /RD, /WR      |

One possible glue implementation uses a 74HC573 address latch on P0/ALE and the following chip selects:

```
ROM  /CE = A15          /OE = /PSEN
RAM0 /CE = A15          /OE = /RD          /WE = /WR
RAM1 /CE = /A15 (A15 inverted)
     /OE = /RD AND /PSEN   (74HC08: low when either strobe is low)
     /WE = /WR
```

MOVX writes to 0x8000–0xFFFF are immediately visible as code, which lets programs be loaded and assembled into upper RAM and then executed.

Reset does not clear either RAM chip; only a power cycle does. In the emulator, a power cycle fills RAM with pseudo-random bytes.

## Serial

* The on-chip UART runs in mode 1 (8N1). Timer 1 in mode 2 is the baud generator.
* DOS/51 uses TH1 = 0xFD with SMOD = 1, giving **19200 baud**. Clearing SMOD gives 9600 baud.
* TxD is P3.1 and RxD is P3.0. A MAX232 or a USB-TTL adapter connects them to the host.

## SD card (SPI on P1.4–P1.7)

An SD card (or a microSD socket) is bit-banged in SPI mode 0 on the upper nibble of port 1:

| Pin | Signal | Direction | Idle |
|------|--------|-----------|------|
| P1.4 | /CS (card pin 1, DAT3) | out | high |
| P1.5 | SCK (card pin 5, CLK) | out | low |
| P1.6 | MOSI (card pin 2, CMD) | out | high |
| P1.7 | MISO (card pin 7, DAT0) | in | latch kept at 1 |

* P1.7 is a quasi-bidirectional input: software must leave its output latch at 1 so the pin is not driven low; the card drives it. Add a 10–47 kΩ pull-up to 3.3 V on MISO (and on the unused DAT1/DAT2) so the line is defined while /CS is high.
* The card runs at 3.3 V. The 80C31 is a 5 V part: use a 3.3 V regulator for the card, level-shift /CS, SCK and MOSI down (for example a 74LVC125 powered from 3.3 V, or resistor dividers), and feed MISO directly into P1.7 (3.3 V is a valid high for the 80C31's TTL input) or through a 74HCT buffer. Many "SD card module" boards already contain the regulator and level shifters.
* Bit-banging gives SCK of roughly 115 kHz at 11.0592 MHz, below the 400 kHz limit for card initialisation, so the same speed is used throughout.
* Protocol (DOS/51 driver, `firmware/src/sd51.asm`): at least 74 clocks with /CS high, CMD0, CMD8 (1AAh) to tell version 2 cards from version 1, ACMD41 with HCS until ready, CMD58 to read CCS (block addressed SDHC/SDXC) and CMD16 512 for byte addressed SDSC cards, then single block CMD17 reads and CMD24 writes. CRCs are sent only where the card checks them (CMD0, CMD8).
* At reset DOS/51 sets P1 to DFh: LEDs off, /CS high, SCK low.

## GPIO used by the examples

* P1.0–P1.3: general purpose. The examples drive four LEDs there, and a low output turns an LED on (LED to VCC through a resistor). Programs must change only these bits (`ANL P1, #mask` / `ORL P1, #mask`, `SETB`/`CLR`/`CPL P1.n`) and never write P1.4–P1.7 directly, because those are the SD card lines; a plain `MOV P1, A` must keep the upper nibble at 1101b.
* P3.2 (/INT0) and P3.3 (/INT1): push buttons to GND with pull-ups.
* P3.4 (T0) and P3.5 (T1): counter inputs.
* P3.6 and P3.7 are /WR and /RD, so they are used by the bus.
* P0 and P2 form the multiplexed address/data bus and are unavailable as I/O.
