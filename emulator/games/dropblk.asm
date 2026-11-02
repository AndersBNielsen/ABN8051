; dropblk.asm - DropBlocks for a VT100 terminal: asm -r dropblk.asm
; Arrows (or WASD / HJKL) move, Up rotates, Down drops one row,
; Space drops, P pauses, Q or Esc quits.
; The board is 16 bytes per row in XDATA: 0 empty, 1-7 a block's
; colour, 8 wall (columns 0 and 11-15, rows 20-23).
BOARD	EQU	0E000h
TICK20	EQU	65536-18432	; Timer 0 overflows every 20 ms
PCELL	EQU	08h		; piece: rows 08h-0Bh, columns 0Ch-0Fh
QCELL	EQU	10h		; candidate position, same layout
PX	DATA	18h		; piece column, row, rotation, type 0-6
PY	DATA	19h
PR	DATA	1Ah
PT	DATA	1Bh
NT	DATA	1Ch		; next type
QX	DATA	20h		; candidate column, row, rotation
QY	DATA	21h
QR	DATA	22h
TICK	DATA	23h
SPEED	DATA	24h		; ticks per row
RND	DATA	25h
LEVEL	DATA	26h
LCNT	DATA	27h		; lines towards the next level
LINES	DATA	28h		; 2 bytes, high first
SCORE	DATA	2Ah		; 2 bytes, points / 10
CURC	DATA	2Ch		; colour last sent
LROW	DATA	2Dh		; cursor after the last cell drawn
LCOL	DATA	2Eh
CNT	DATA	2Fh		; full rows / kick index
TOP	DATA	1Dh
LOWC	DATA	1Eh

	ORG	8000h
	MOV	R0, #8		; clear 08h-2Fh
clr:	MOV	@R0, #0
	INC	R0
	CJNE	R0, #30h, clr
	ANL	TMOD, #0F0h	; Timer 0: 16 bit, polled, Timer 1 untouched
	ORL	TMOD, #01h
	SETB	TR0
	MOV	R6, #23		; build the board and walls
bi1:	MOV	R7, #15
bi2:	ACALL	addr
	MOV	A, R7
	JZ	bi3
	ADD	A, #-11
	JC	bi3
	MOV	A, R6
	ADD	A, #-20
	JC	bi3
	CLR	A
	SJMP	bi4
bi3:	MOV	A, #8
bi4:	MOVX	@DPTR, A
	DEC	R7
	CJNE	R7, #0FFh, bi2
	DEC	R6
	CJNE	R6, #0FFh, bi1
	LCALL	PUTSI
	DB	27, "[0m", 27, "[2J", 27, "[?25l", 0
	MOV	R6, #2
scr:	MOV	A, R6
	MOV	B, #1
	ACALL	gotoxy
	LCALL	PUTSI
	DB	"<! . . . . . . . . . .!>", 0
	INC	R6
	CJNE	R6, #22, scr
	LCALL	PUTSI
	DB	10, "<!====================!>"
	DB	27, "[2;28HDOS/51 DROPBLOCKS", 27, "[4;28HNext"
	DB	27, "[9;28HScore", 27, "[10;28HLines", 27, "[11;28HLevel"
	DB	27, "[14;28HLeft/Right a d  move"
	DB	27, "[15;28HUp         w    rotate"
	DB	27, "[16;28HDown       s    down"
	DB	27, "[17;28HSpace           drop"
	DB	27, "[18;28HP pause    Q    quit", 0
	ACALL	stats
	ACALL	at20
	LCALL	PUTSI
	DB	"Press a key", 0
	ACALL	wkey
	MOV	RND, TL0	; seed from the time the player took
	ACALL	rand
	MOV	NT, A
	ACALL	setspd
	ACALL	newp

loop:	JNB	TF0, key	; 20 ms tick: gravity
	CLR	TF0
	MOV	TH0, #HIGH(TICK20)
	INC	TICK
	MOV	A, TICK
	CLR	C
	SUBB	A, SPEED
	JC	key
	ACALL	down
key:	LCALL	KBHIT
	JNC	loop
	LCALL	GETKEY
	JZ	loop		; unknown escape sequence
	CJNE	A, #27, k1
	SJMP	quit
k1:	JB	ACC.7, k2
	ORL	A, #20h		; lower case
k2:	MOV	R2, A
	MOV	DPTR, #keys
k3:	CLR	A
	MOVC	A, @A+DPTR
	JZ	loop
	INC	DPTR
	XRL	A, R2
	JZ	k4
	INC	DPTR
	SJMP	k3
k4:	MOVC	A, @A+DPTR
	ACALL	k5
	SJMP	loop
k5:	MOV	DPTR, #acts
	JMP	@A+DPTR
acts:	AJMP	left
	AJMP	right
	AJMP	rotate
	AJMP	down
	AJMP	drop
	AJMP	pause
quit:	CLR	TR0
	LCALL	PUTSI
	DB	27, "[0m", 27, "[2J", 27, "[H", 27, "[?25h", 0
	LJMP	EXIT
keys:	DB	82h, 0, 'a', 0, 'h', 0, 83h, 2, 'd', 2, 'l', 2
	DB	80h, 4, 'w', 4, 'k', 4, 'x', 4, 81h, 6, 's', 6, 'j', 6
	DB	' ', 8, 'p', 10, 'q', 12, 0

left:	ACALL	setq
	DEC	QX
	AJMP	try
right:	ACALL	setq
	INC	QX
	AJMP	try
rotate:	ACALL	setq
	MOV	A, QR
	INC	A
	ANL	A, #3
	MOV	QR, A
	MOV	CNT, #0
ro1:	MOV	A, CNT		; wall kick: shift 0, +1, -1, +2, -2
	INC	CNT
	MOV	DPTR, #kicks
	MOVC	A, @A+DPTR
	CJNE	A, #80h, ro2
	RET
ro2:	ADD	A, PX
	MOV	QX, A
	ACALL	try
	JC	ro1
	RET
kicks:	DB	0, 1, 0FFh, 2, 0FEh, 80h
pause:	ACALL	at20
	LCALL	PUTSI
	DB	"Paused", 0
wkey:	LCALL	GETKEY
	ACALL	at20
	LCALL	PUTSI
	DB	27, "[K", 0
	RET
at20:	MOV	A, #20
	MOV	B, #28
	AJMP	gotoc
down:	MOV	TICK, #0
	ACALL	setq
	INC	QY
	ACALL	try
	JC	lockit
	RET
drop:	ACALL	setq
dp1:	INC	QY		; find the lowest free row
	ACALL	cells
	ACALL	hit
	JNC	dp1
	DEC	QY
	ACALL	try

lockit:	MOV	R0, #PCELL	; piece -> board
lk1:	ACALL	celld
	MOV	A, PT
	INC	A
	MOVX	@DPTR, A
	INC	R0
	CJNE	R0, #PCELL+4, lk1
	MOV	CNT, #0		; remove full rows: copy row R6 to R5
	MOV	LOWC, #0
	MOV	R6, #19
	MOV	R5, #19
lc1:	MOV	A, R6
	ACALL	rowp
	MOV	R2, #0		; R2 = blocks in the row
	MOV	R7, #10
lc2:	INC	DPTR
	MOVX	A, @DPTR
	JZ	lc3
	INC	R2
lc3:	DJNZ	R7, lc2
	MOV	A, R2
	JZ	lc4
	MOV	TOP, R6		; highest row in use
lc4:	CJNE	R2, #10, lc5
	INC	CNT
	MOV	A, LOWC
	JNZ	lc7
	MOV	LOWC, R6	; lowest full row
	SJMP	lc7
lc5:	MOV	R7, #10
lc6:	ACALL	addr
	MOVX	A, @DPTR
	MOV	R2, A
	MOV	A, R5
	ACALL	rowp
	MOV	A, R7
	ORL	A, DPL
	MOV	DPL, A
	MOV	A, R2
	MOVX	@DPTR, A
	DJNZ	R7, lc6
	DEC	R5
lc7:	DEC	R6
	CJNE	R6, #0FFh, lc1
lc8:	CJNE	R5, #0FFh, lc9	; empty rows at the top
	SJMP	lc11
lc9:	MOV	A, R5
	ACALL	rowp
	MOV	R7, #10
lc10:	INC	DPTR
	CLR	A
	MOVX	@DPTR, A
	DJNZ	R7, lc10
	DEC	R5
	SJMP	lc8
lc11:	MOV	A, CNT
	JZ	newp
	MOV	R6, TOP		; redraw the rows that moved
rd1:	MOV	R7, #1
rd2:	ACALL	addr
	MOVX	A, @DPTR
	ACALL	drawc
	INC	R7
	CJNE	R7, #11, rd2
	MOV	A, R6
	INC	R6
	CJNE	A, LOWC, rd1
	MOV	A, CNT		; lines, score += pts * (level + 1)
	ADD	A, LINES+1
	MOV	LINES+1, A
	CLR	A
	ADDC	A, LINES
	MOV	LINES, A
	MOV	A, CNT
	MOV	DPTR, #pts-1
	MOVC	A, @A+DPTR
	MOV	B, LEVEL
	INC	B
	MUL	AB
	ADD	A, SCORE+1
	MOV	SCORE+1, A
	MOV	A, B
	ADDC	A, SCORE
	MOV	SCORE, A
	MOV	A, LCNT		; level up every 10 lines
	ADD	A, CNT
	MOV	LCNT, A
	ADD	A, #-10
	JNC	lc12
	MOV	LCNT, A
	INC	LEVEL
	ACALL	setspd
lc12:	ACALL	stats

newp:	MOV	PT, NT		; next piece
	ACALL	rand
	CJNE	A, PT, np1
	ACALL	rand		; one retry against repeats
np1:	MOV	NT, A
	CLR	A		; preview
	ACALL	setc
	LCALL	PUTSI
	DB	27, "[5;29H        ", 27, "[6;29H        ", 0
	MOV	LROW, #0FFh
	PUSH	PT
	MOV	PT, NT
	MOV	QX, #14
	MOV	QY, #3
	MOV	QR, #0
	ACALL	cells
	MOV	A, PT
	INC	A
	MOV	R0, #QCELL
	ACALL	draw4
	POP	PT
	MOV	QX, #4		; enter at the top
	MOV	QY, #0
	ACALL	cells
	ACALL	hit
	JC	over
	SJMP	place

over:	MOV	A, #11
	MOV	B, #7
	ACALL	gotoc
	LCALL	PUTSI
	DB	" GAME OVER ", 0
	ACALL	at20
	LCALL	PUTSI
	DB	"Press a key", 0
	ACALL	wkey
	AJMP	quit

; try: move to QX, QY, QR if it fits; C = 1 if blocked
try:	ACALL	cells
	ACALL	hit
	JC	tr1
	CLR	A
	ACALL	drawp		; erase
	ACALL	place
	CLR	C
tr1:	RET
place:	MOV	PX, QX
	MOV	PY, QY
	MOV	PR, QR
	MOV	R0, #QCELL
	MOV	R1, #PCELL
pl1:	MOV	A, @R0
	MOV	@R1, A
	INC	R0
	INC	R1
	CJNE	R1, #QCELL, pl1
	MOV	A, PT
	INC	A
drawp:	MOV	R0, #PCELL	; draw the piece in colour A (0 = erase)
draw4:	MOV	R3, #4
dw1:	MOV	R2, A
	ACALL	celld
	MOV	A, R2
	ACALL	drawc
	INC	R0
	DJNZ	R3, dw1
	RET

setq:	MOV	QX, PX
	MOV	QY, PY
	MOV	QR, PR
	RET

; cells: the 4 cells of type PT at QX, QY, QR -> QCELL
cells:	MOV	A, PT
	RL	A
	RL	A
	ADD	A, QR
	RL	A
	MOV	R2, A
	MOV	DPTR, #shapes
	MOVC	A, @A+DPTR
	MOV	R4, A
	MOV	A, R2
	INC	A
	MOVC	A, @A+DPTR
	MOV	R5, A
	MOV	R0, #QCELL
	MOV	R3, #0		; bit R3: row R3 / 4, column R3 mod 4
ce1:	MOV	A, R5
	ADD	A, R5
	MOV	R5, A
	MOV	A, R4
	RLC	A
	MOV	R4, A
	JNC	ce2
	MOV	A, R3
	RR	A
	RR	A
	ANL	A, #3
	ADD	A, QY
	MOV	@R0, A
	MOV	A, R0
	ADD	A, #4
	MOV	R1, A
	MOV	A, R3
	ANL	A, #3
	ADD	A, QX
	MOV	@R1, A
	INC	R0
ce2:	INC	R3
	CJNE	R3, #16, ce1
	RET

; hit: C = 1 if a QCELL cell is not empty
hit:	MOV	R0, #QCELL
hi1:	ACALL	celld
	MOVX	A, @DPTR
	ADD	A, #0FFh
	JC	hi2
	INC	R0
	CJNE	R0, #QCELL+4, hi1
hi2:	RET

; celld: R6, R7 = row, column of cell @R0; DPTR = its board byte
celld:	MOV	A, @R0
	MOV	R6, A
	MOV	A, R0
	ADD	A, #4
	MOV	R1, A
	MOV	A, @R1
	MOV	R7, A
addr:	MOV	A, R6		; DPTR = board row R6, column R7
	ACALL	rowp
	MOV	A, R7
	ANL	A, #0Fh
	ORL	A, DPL
	MOV	DPL, A
	RET
rowp:	SWAP	A		; DPTR = BOARD + 16 * A
	PUSH	ACC
	ANL	A, #0F0h
	MOV	DPL, A
	POP	ACC
	ANL	A, #0Fh
	ADD	A, #HIGH(BOARD)
	MOV	DPH, A
	RET

; drawc: draw value A at row R6, column R7
drawc:	PUSH	ACC
	MOV	A, R6
	CJNE	A, LROW, dc1
	MOV	A, LCOL
	INC	A
	XRL	A, R7
	JZ	dc2		; the cursor is already there
dc1:	MOV	A, R7
	RL	A
	INC	A
	MOV	B, A
	MOV	A, R6
	ADD	A, #2
	ACALL	gotoxy
	MOV	LROW, R6
dc2:	MOV	LCOL, R7
	POP	ACC
	ACALL	setc
	JZ	dc3
	LCALL	PUTSI
	DB	"[]", 0
	RET
dc3:	LCALL	PUTSI
	DB	" .", 0
	RET

; setc: select colour A (0 = normal), A is kept
setc:	CJNE	A, CURC, sc1
	RET
sc1:	MOV	CURC, A
	PUSH	ACC
	LCALL	PUTSI
	DB	27, "[0", 0
	JZ	sc2
	LCALL	PUTSI
	DB	";1;3", 0
	ORL	A, #30h
	LCALL	PUTC
sc2:	MOV	A, #'m'
	LCALL	PUTC
	POP	ACC
	RET

; gotoxy: cursor to row A, column B; gotoc also selects colour 0
gotoc:	PUSH	ACC
	CLR	A
	ACALL	setc
	POP	ACC
gotoxy:	MOV	LROW, #0FFh
	PUSH	ACC
	LCALL	PUTSI
	DB	27, "[", 0
	POP	ACC
	ACALL	pdec
	MOV	A, #3Bh		; ';'
	LCALL	PUTC
	MOV	A, B
	ACALL	pdec
	MOV	A, #'H'
	LJMP	PUTC
pdec:	MOV	DPH, #0
	MOV	DPL, A
	LJMP	PUTDEC

stats:	MOV	A, #9		; score, lines, level
	MOV	B, #35
	ACALL	gotoc
	MOV	DPH, SCORE
	MOV	DPL, SCORE+1
	LCALL	PUTDEC
	MOV	A, DPL
	ORL	A, DPH
	JZ	st1
	MOV	A, #'0'
	LCALL	PUTC
st1:	MOV	A, #10
	ACALL	gotoxy
	MOV	DPH, LINES
	MOV	DPL, LINES+1
	LCALL	PUTDEC
	MOV	A, #11
	ACALL	gotoxy
	MOV	A, LEVEL
	SJMP	pdec

setspd:	MOV	A, LEVEL	; SPEED = speeds[min(LEVEL, 13)]
	CJNE	A, #13, sp1
sp1:	JC	sp2
	MOV	A, #13
sp2:	MOV	DPTR, #speeds
	MOVC	A, @A+DPTR
	MOV	SPEED, A
	RET

rand:	MOV	A, RND		; A = random 0-6
	MOV	B, #5
	MUL	AB
	ADD	A, TL0
	INC	A
	MOV	RND, A
	MOV	B, #7
	DIV	AB
	MOV	A, B
	RET

speeds:	DB	40, 36, 32, 28, 24, 20, 16, 13, 10, 8, 6, 5, 4, 3
pts:	DB	4, 10, 30, 120	; 40, 100, 300, 1200 points
; 4x4 masks, one hex digit per row (8 = left), 4 rotations each:
; Z red, S green, O yellow, J blue, T magenta, I cyan, L white
shapes:	DB	0C6h, 0, 26h, 40h, 0Ch, 60h, 4Ch, 80h
	DB	6Ch, 0, 46h, 20h, 06h, 0C0h, 8Ch, 40h
	DB	66h, 0, 66h, 0, 66h, 0, 66h, 0
	DB	8Eh, 0, 64h, 40h, 0Eh, 20h, 44h, 0C0h
	DB	4Eh, 0, 46h, 40h, 0Eh, 40h, 4Ch, 40h
	DB	0Fh, 0, 22h, 22h, 0, 0F0h, 44h, 44h
	DB	2Eh, 0, 44h, 60h, 0Eh, 80h, 0C4h, 40h
	END
