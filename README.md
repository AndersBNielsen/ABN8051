# ABN8051 / DOS/51

An 80C31 computer design and DOS/51 software project. The proposed memory map uses a 32 KiB ROM and two 32 KiB RAM chips; upper RAM is mapped into both CODE and XDATA so assembled programs can execute there. The 11.0592 MHz clock supports a 19,200-baud serial console. The board has not yet been bench-verified.

The complete DOS, SDCC firmware source, seven assembly examples, command-line 8051 emulator, browser interface and tests live in [emulator/](emulator/README.md). The hardware wiring and address decoding are documented in [emulator/docs/HARDWARE.md](emulator/docs/HARDWARE.md). [Try DOS/51 in your browser](https://www.imania.dk/dos51-865e9723ece6/).

From `emulator/`, run `make -C firmware` to rebuild the 32 KiB ROM, `npm test` to run the suite, or `node bin/dos51.js` for a local serial console. See the emulator README for prerequisites and usage.

## Licensing

The DOS/51 source is published here without a project-wide license grant. The bundled xterm.js is separately licensed under MIT; see [its license](emulator/site/vendor/xterm.LICENSE). A license for the original DOS/51 and emulator code should be added if reuse rights beyond GitHub's default viewing/forking terms are intended.
