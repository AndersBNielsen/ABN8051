# DOS/51 ROM - build with SDCC 4.x:  make   ->  build/dos51.ihx, build/dos51.bin (32K)
#
# C modules use --model-medium (locals in paged XDATA at 1D00h, P2 = 1Dh);
# the size critical parts are hand written assembler (sdas8051).
SDCC    ?= sdcc
SDAS    ?= sdas8051
PY      ?= python3
CFLAGS  = -mmcs51 --model-medium --opt-code-size --std-sdcc11 -Isrc
LDFLAGS = --code-size 0x7F00 --xram-loc 0x0000 --xram-size 0x0A00 --iram-size 128 \
          --data-loc 0x08 -Wl-bPSEG=0x1D00 -Wl-bXSEG=0x0000
B       = build
CSRC    = main.c vectors.c shell.c editor.c asm.c
ASRC    = syscalls.asm asm51.asm lib51.asm fs51.asm xm51.asm sd51.asm shell51.asm
RELS    = $(addprefix $(B)/,$(CSRC:.c=.rel) $(ASRC:.asm=.rel)) $(B)/exdata.rel

all: $(B)/dos51.bin

$(B)/%.rel: src/%.c src/dos.h Makefile | $(B)
	$(SDCC) $(CFLAGS) -c $< -o $@

$(B)/%.rel: src/%.asm | $(B)
	$(SDAS) -plosgff $@ $<

EXDIR  ?= examples
$(B)/exdata.asm: $(wildcard $(EXDIR)/*) ../scripts/gen_examples.py | $(B)
	$(PY) ../scripts/gen_examples.py $(EXDIR) $@

$(B)/exdata.rel: $(B)/exdata.asm
	$(SDAS) -plosgff $@ $<

$(B)/dos51.ihx: $(RELS)
	$(SDCC) $(CFLAGS) $(LDFLAGS) $(RELS) -o $@

$(B)/dos51.bin: $(B)/dos51.ihx
	$(PY) ../scripts/ihx2bin.py $< $@ 32768
	@$(PY) ../scripts/romsize.py $(B)/dos51.map

$(B):
	mkdir -p $(B)

clean:
	rm -rf $(B)
.PHONY: all clean
