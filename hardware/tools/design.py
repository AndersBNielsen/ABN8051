"""ABN8051 schematic generator. Run: python3 design.py OUTDIR"""
import sys, os, json
from schgen import Sch, mk_ic, write_symlib, G
from sexp import q

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
SYMLIB = os.path.join(OUT, 'ABN8051.kicad_sym')

# ---------------------------------------------------------------- project symbols
P, I, O, B, T, W, WO, NC = 'passive', 'input', 'output', 'bidirectional', 'tri_state', 'power_in', 'power_out', 'no_connect'
syms = []
syms.append(mk_ic('SN74ALS873B',
    left=[('3', '1D1', I), ('4', '1D2', I), ('5', '1D3', I), ('6', '1D4', I), ('7', '2D1', I), ('8', '2D2', I),
          ('9', '2D3', I), ('10', '2D4', I), None, ('23', '1C', I), ('14', '2C', I), ('2', '~{1OE}', I),
          ('11', '~{2OE}', I), ('1', '~{1CLR}', I), ('13', '~{2CLR}', I)],
    right=[('22', '1Q1', T), ('21', '1Q2', T), ('20', '1Q3', T), ('19', '1Q4', T), ('18', '2Q1', T), ('17', '2Q2', T),
           ('16', '2Q3', T), ('15', '2Q4', T)],
    top=[('24', 'VCC', W)], bottom=[('12', 'GND', W)], hw=4,
    footprint='Package_DIP:DIP-24_W7.62mm', datasheet='https://www.ti.com/lit/gpn/SN74ALS873B',
    desc='Dual 4-bit D-type transparent latch, 3-state outputs, DIP-24 (300 mil)'))
syms.append(mk_ic('KF33BD',
    left=[('8', 'VIN', W), ('5', 'INH', I)], right=[('1', 'VOUT', WO), ('4', 'NC', NC)],
    bottom=[('2', 'GND', W), ('3', 'GND', W), ('6', 'GND', W), ('7', 'GND', W)], hw=4,
    footprint='Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', datasheet='https://www.st.com/resource/en/datasheet/kfxx.pdf',
    desc='3.3 V 500 mA LDO with inhibit, SO-8'))
syms.append(mk_ic('DM3CS-SF',
    left=[('1', 'DAT2', B), ('2', 'CD/DAT3', B), ('3', 'CMD', B), ('4', 'VDD', W), ('5', 'CLK', I), ('6', 'VSS', W),
          ('7', 'DAT0', B), ('8', 'DAT1', B)],
    right=[('CD', 'DET_SW', P), None, None, None, None, None, None, ('SH', 'SHIELD', P)], hw=5, ref='J',
    footprint='ABN8051:microSD_Hirose_DM3CS-SF', datasheet='https://www.hirose.com/en/product/p/CL0609-0032-3-00',
    desc='Hirose DM3CS-SF hinged microSD holder; detect switch closes to shield/GND with card inserted'))
syms.append(mk_ic('MA-406',
    left=[('1', 'X1', P), ('2', 'NC', NC)], right=[('4', 'X2', P), ('3', 'NC', NC)], hw=3, ref='Y',
    footprint='Crystal:Crystal_SMD_SeikoEpson_MA406-4Pin_11.7x4.0mm',
    datasheet='https://download.epson-europe.com/pub/electronics-de/quartz/ma406.pdf',
    desc='Epson MA-406 SMD crystal; element between #1 and #4, #2/#3 must stay unconnected'))
write_symlib(SYMLIB, syms)

s = Sch('ABN8051', paper='A3', title='ABN8051 - 80C31 single-board computer for DOS/51', rev='0.1',
        date='2026-11-13', company='Anders Nielsen / iMania.dk',
        comments=('Generated netlist-first; verify on the bench before ordering in volume.',
                  'ROM 0000-7FFF (CODE), RAM0 0000-7FFF (XDATA), RAM1 8000-FFFF (CODE+XDATA)'))

FP_R = 'Resistor_SMD:R_0805_2012Metric'
FP_C = 'Capacitor_SMD:C_0805_2012Metric'
FP_C12 = 'Capacitor_SMD:C_1206_3216Metric'
FP_LED = 'LED_SMD:LED_0805_2012Metric'
FP_SJ3 = 'Jumper:SolderJumper-3_P1.3mm_Bridged12_RoundedPad1.0x1.5mm'
FP_SJ2B = 'Jumper:SolderJumper-2_P1.3mm_Bridged_RoundedPad1.0x1.5mm'
FP_SJ2O = 'Jumper:SolderJumper-2_P1.3mm_Open_RoundedPad1.0x1.5mm'
FP_BTN = 'Button_Switch_SMD:SW_SPST_TL3342'
LC = {'100nF': 'C49678', '22pF': 'C1804', '10uF': 'C13585', '1k': 'C17513', '10k': 'C17414', '5k1': 'C27834',
      '330R': 'C17630', '47k': 'C17713'}
def lc(v):
    return {'LCSC': LC[v]} if v in LC else {}
def im(pid, **kw):
    d = {'iMania': str(pid)}; d.update(kw); return d

def two(lib, ref, val, gx, gy, n1, n2, fp, props=None, **kw):
    return s.place(lib, ref, val, gx, gy, {'1': n1, '2': n2}, rot=90, fp=fp, props=props or {},
                   refpos=(0, -2.3), valpos=(0, 2.9), **kw)
def R(ref, val, gx, gy, n1, n2): return two('Device:R_Small', ref, val, gx, gy, n1, n2, FP_R, lc(val))
def C(ref, val, gx, gy, n1, n2, fp=None):
    return two('Device:C_Small', ref, val, gx, gy, n1, n2, fp or (FP_C12 if val == '10uF' else FP_C), lc(val))
def BTN(ref, val, gx, gy, n1, n2):
    return s.place('Switch:SW_Push', ref, val, gx, gy, {'1': n1, '2': n2}, fp=FP_BTN, props={'LCSC': 'C318884'})
def LED(ref, val, gx, gy, k, a, lcsc):
    return s.place('Device:LED', ref, val, gx, gy, {'1': k, '2': a}, fp=FP_LED, props={'LCSC': lcsc})

AD = ['AD%d' % i for i in range(8)]
A = ['A%d' % i for i in range(16)]

# ================================================================ CPU
s.box(10, 16, 132, 178, 'CPU, clock, reset')
cpu = {'9': 'RST', '10': 'RXD', '11': 'TXD', '12': '~{INT0}', '13': '~{INT1}', '14': 'T0', '15': 'T1',
       '16': '~{WR}', '17': '~{RD}', '18': 'XTAL2', '19': 'XTAL1', '20': 'GND', '29': '~{PSEN}', '30': 'ALE',
       '31': 'GND', '40': '+5V'}
for i in range(8):
    cpu[str(1 + i)] = 'P1.%d' % i
    cpu[str(21 + i)] = A[8 + i]
    cpu[str(39 - i)] = AD[i]
s.place('MCU_Intel:P8031AH', 'U1', 'P80C31SFPN', 28, 25, cpu, fp='Package_DIP:DIP-40_W15.24mm',
        props=im(7389, LCSC='C72123', Datasheet='https://www.nxp.com/docs/en/data-sheet/80C31_80C32.pdf'))
s.text('EA tied low: all code is fetched\nfrom the external ROM / RAM1.', 5 * G, 43.5 * G, 1.1)
C('C15', '10uF', 13, 48, '+5V', 'RST')
R('R3', '10k', 13, 51.5, 'RST', 'GND')
BTN('SW2', 'RESET', 13, 55.5, '+5V', 'RST')
C('C1', '100nF', 13, 59.5, '+5V', 'GND')
s.place('Device:Crystal', 'Y1', '11.0592MHz', 36, 49, {'1': 'XTAL1', '2': 'XTAL2'},
        fp='Crystal:Crystal_SMD_HC49-SD', props=im(7354))
C('C11', '22pF', 36, 53.5, 'XTAL1', 'GND')
C('C12', '22pF', 36, 57, 'XTAL2', 'GND')
BTN('SW3', 'INT0', 36, 61.5, '~{INT0}', 'GND')
BTN('SW4', 'INT1', 36, 65.5, '~{INT1}', 'GND')
C('C16', '10uF', 13, 63, '+5V', 'GND')
C('C17', '10uF', 13, 66.5, '+5V', 'GND')

# ================================================================ latch + decode
s.box(136, 16, 262, 178, 'Address latch, glue logic')
lat = {'24': '+5V', '12': 'GND', '23': 'ALE', '14': 'ALE', '2': 'GND', '11': 'GND', '1': '+5V', '13': '+5V'}
for i in range(8):
    lat[str(3 + i)] = AD[i]
    lat[str(22 - i)] = A[i]
s.place('ABN8051:SN74ALS873B', 'U2', 'SN74ALS873BNT', 67, 21, lat, fp='Package_DIP:DIP-24_W7.62mm',
        props=im(7307), libpath=SYMLIB)
NAND = dict(fp='Package_DIP:DIP-14_W7.62mm', props=im(7450, LCSC='C2325', Alt='74HCT00 / 74HC00'))
s.place('74xx:74HCT00', 'U6', '74LS00 / 74HCT00', 66, 39, {'1': 'A15', '2': 'A15', '3': '~{A15}'}, unit=1, **NAND)
s.place('74xx:74HCT00', 'U6', '74LS00 / 74HCT00', 66, 45, {'4': '~{RD}', '5': '~{PSEN}', '6': 'RD_OR_PSEN'}, unit=2, **NAND)
s.place('74xx:74HCT00', 'U6', '74LS00 / 74HCT00', 66, 51, {'9': 'RD_OR_PSEN', '10': 'RD_OR_PSEN', '8': '~{RAM1OE}'}, unit=3, **NAND)
s.place('74xx:74HCT00', 'U6', '74LS00 / 74HCT00', 66, 57, {'12': 'RST', '13': 'RST', '11': '~{RST}'}, unit=4, **NAND)
s.place('74xx:74HCT00', 'U6', '74LS00 / 74HCT00', 90, 46, {'14': '+5V', '7': 'GND'}, unit=5, **NAND)
s.text('U6A: ~A15 selects RAM1\nU6B+C: RAM1 ~OE = ~RD AND ~PSEN\n  (RAM1 is both code and data)\nU6D: active-low reset for add-ons',
       80 * G, 57 * G, 1.1)
C('C2', '100nF', 62, 63, '+5V', 'GND')
C('C6', '100nF', 80, 63, '+5V', 'GND')
s.text('C2: U2, C6: U6', 86 * G, 66.5 * G, 1.0)

# ================================================================ memory
s.box(266, 16, 410, 178, 'Memory: ROM + 2 x RAM')
def mem_addr(d, pins, n):
    for i, p in enumerate(pins[:n]): d[str(p)] = A[i]
APINS = [10, 9, 8, 7, 6, 5, 4, 3, 25, 24, 21, 23, 2, 26, 27, 1]      # 27C512 A0..A15
DPINS = [11, 12, 13, 15, 16, 17, 18, 19]
rom = {'14': 'GND', '28': '+5V', '20': 'A15', '22': '~{PSEN}', '1': 'ROM_P1'}
mem_addr(rom, APINS, 15)
for i, p in enumerate(DPINS): rom[str(p)] = AD[i]
s.place('Memory_EPROM:27C512', 'U3', 'W27C512 / 27C256', 113, 25, rom, fp='Package_DIP:DIP-28_W15.24mm',
        props=im(7194, LCSC='C72121'))
RPINS = [10, 9, 8, 7, 6, 5, 4, 3, 25, 24, 21, 23, 2, 26, 1]          # 62256 A0..A14
def ram(ref, gx, p26, cs, oe):
    d = {'14': 'GND', '28': '+5V', '20': cs, '22': oe, '27': '~{WR}'}
    mem_addr(d, RPINS, 15)
    d['26'] = p26
    for i, p in enumerate(DPINS): d[str(p)] = AD[i]
    s.place('Memory_RAM:HM62256BLP', ref, '62256 / 6264', gx, 25, d, fp='Package_DIP:DIP-28_W15.24mm',
            props=im(7234, LCSC='C72121', Alt='HM6264LP-15 (iMania 7393)'), stubs={'22': 2, '20': 2, '27': 2})
ram('U4', 131, 'RAM0_P26', 'A15', '~{RD}')
ram('U5', 150, 'RAM1_P26', '~{RAM1CE}', '~{RAM1OE}')
s.text('ROM  CODE 0000-7FFF', 107 * G, 10.2 * G, 1.4, True); s.text('RAM0  XDATA 0000-7FFF', 125 * G, 10.2 * G, 1.4, True)
s.text('RAM1  CODE+XDATA 8000-FFFF', 144 * G, 10.2 * G, 1.4, True)
J3P = dict(fp='Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical')
s.place('Jumper:Jumper_3_Bridged12', 'JP1', 'ROM pin 1', 112, 43, {'1': 'GND', '2': 'ROM_P1', '3': '+5V'}, refpos=(0, -5.4), valpos=(0, -3.4), **J3P)
s.text('JP1  1-2: W27C512 lower half\n     2-3: W27C512 upper half, or 27C256 (Vpp = 5 V)', 119 * G, 43.5 * G, 1.1)
s.place('Jumper:SolderJumper_3_Bridged12', 'JP2', 'RAM0 32K/8K', 112, 52, {'1': 'A13', '2': 'RAM0_P26', '3': '+5V'}, refpos=(0, -5.4), valpos=(0, -3.4), fp=FP_SJ3)
s.place('Jumper:SolderJumper_3_Bridged12', 'JP3', 'RAM1 32K/8K', 130, 52, {'1': 'A13', '2': 'RAM1_P26', '3': '+5V'}, refpos=(0, -5.4), valpos=(0, -3.4), fp=FP_SJ3)
s.text('JP2/JP3  1-2 (default): 62256, pin 26 = A13\n         2-3: 6264, pin 26 = CS2 high (8K, mirrored)', 106 * G, 62 * G, 1.1)
s.place('Jumper:SolderJumper_3_Bridged12', 'JP4', 'RAM1 select', 150, 52, {'1': '~{A15}', '2': '~{RAM1CE}', '3': '~{IO4}'}, refpos=(0, -5.4), valpos=(0, -3.4), fp=FP_SJ3)
s.text('JP4  1-2 (default): RAM1 = 8000-FFFF\n     2-3: RAM1 = 8000-9FFF only (U7 fitted),\n          A000-FFFF free for add-ons', 141 * G, 62.6 * G, 1.1)
C('C3', '100nF', 111, 66, '+5V', 'GND'); C('C4', '100nF', 126, 66, '+5V', 'GND'); C('C5', '100nF', 141, 66, '+5V', 'GND')
s.text('C3: U3, C4: U4, C5: U5', 148 * G, 66.5 * G, 1.0)

# ================================================================ USB / UART / power
s.box(10, 182, 172, 285, 'USB-C power, CH340G USB serial')
usb = {'A5': 'CC1', 'B5': 'CC2', 'SH': 'GND'}
for p in ('A4', 'A9', 'B4', 'B9'): usb[p] = 'VBUS'
for p in ('A1', 'A12', 'B1', 'B12'): usb[p] = 'GND'
for p in ('A6', 'B6'): usb[p] = 'USB_DP'
for p in ('A7', 'B7'): usb[p] = 'USB_DM'
s.place('Connector:USB_C_Receptacle_USB2.0_16P', 'J1', 'USB-C', 11, 87, usb,
        fp='Connector_USB:USB_C_Receptacle_HCTL_HC-TYPE-C-16P-01A', props={'LCSC': 'C2894897'})
R('R1', '5k1', 31, 76, 'CC1', 'GND'); R('R2', '5k1', 31, 79.5, 'CC2', 'GND')
two('Device:Polyfuse_Small', 'F1', '500mA', 31, 83.5, 'VBUS', 'VFUSE', 'Fuse:Fuse_1206_3216Metric', {'LCSC': 'C20799'})
s.place('Switch:SW_SPDT', 'SW1', 'POWER', 31, 88.5, {'1': 'VFUSE', '2': '+5V'},
        fp='Button_Switch_THT:SW_Slide-03_Wuerth-WS-SLTV_10x2.5x6.4_P2.54mm',
        props={'Note': '2.54 mm pitch slide switch >= 300 mA, or wire link 1-2'})
LED('D5', 'PWR green', 31, 93.5, 'GND', 'PWR_LED', 'C2297')
R('R8', '1k', 31, 97.5, '+5V', 'PWR_LED')
s.place('Connector_Generic:Conn_01x02', 'J7', '5V in/out', 40, 102, {'1': '+5V', '2': 'GND'},
        fp='Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical')
s.text('SW1: any 2.54 mm pitch slide switch,\nor solder a wire link 1-2.', 36 * G, 88 * G, 1.0)
ch = {'1': 'GND', '16': '+5V', '4': 'CH_V3', '5': 'USB_DP', '6': 'USB_DM', '7': 'CH_XI', '8': 'CH_XO',
      '2': 'CH_TXD', '3': 'TXD'}
s.place('Interface_USB:CH340G', 'U8', 'CH340G', 52, 84, ch, fp='Package_SO:SOIC-16_3.9x9.9mm_P1.27mm',
        props={'LCSC': 'C14267'}, stubs={'4': 4})
R('R9', '1k', 52, 95.5, 'CH_TXD', 'RXD')
s.text('R9 lets an external adapter\non J4 override the CH340.', 57.5 * G, 99 * G, 1.0)
C('C19', '100nF', 52, 99.5, 'CH_V3', 'GND')
C('C8', '100nF', 52, 103, '+5V', 'GND')
s.place('ABN8051:MA-406', 'Y2', '12MHz', 27, 108.5, {'1': 'CH_XI', '4': 'CH_XO'},
        fp='Crystal:Crystal_SMD_SeikoEpson_MA406-4Pin_11.7x4.0mm', props=im(7355), libpath=SYMLIB)
C('C13', '22pF', 11, 104.5, 'CH_XI', 'GND'); C('C14', '22pF', 11, 108.5, 'CH_XO', 'GND')
s.place('Connector_Generic:Conn_01x03', 'J4', 'UART', 63, 108, {'1': 'GND', '2': 'RXD', '3': 'TXD'}, stubs={'1': 5},
        fp='Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical')

# ================================================================ SD card
s.box(176, 182, 300, 285, 'microSD (3.3 V, bit-banged SPI on P1.4-P1.7)')
s.place('ABN8051:KF33BD', 'U9', 'KF33BD-TR', 80, 77, {'8': '+5V', '5': 'GND', '1': '+3V3', '2': 'GND', '3': 'GND',
        '6': 'GND', '7': 'GND'}, fp='Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', props=im(7345), libpath=SYMLIB,
        draw={'3': 'N', '6': 'N', '7': 'N'}, stubs={'5': 3})
_p = [s.pinpos('ABN8051:KF33BD', 1, n, 80 * G, 77 * G) for n in ('2', '3', '6', '7')]
s.wire(*_p)
C('C20', '100nF', 77, 85, '+5V', 'GND')
two('Device:C_Polarized_Small', 'C18', '10uF tant', 77, 88.5, '+3V3', 'GND',
    'Capacitor_Tantalum_SMD:CP_EIA-3216-18_Kemet-A', {'LCSC': 'C7171'})
s.text('KF33 needs output ESR 0.1-10 ohm:\nuse the tantalum, not an MLCC.\nINHIBIT low = regulator on.', 71 * G, 93.5 * G, 1.0)
LVC = dict(fp='Package_SO:TSSOP-14_4.4x5mm_P0.65mm', props=im(7520))
s.place('74xx:74LS08', 'U10', 'SN74LVC08APWR', 96, 76, {'1': 'P1.4', '2': 'P1.4', '3': 'SD_CS'}, unit=1, showval=False, **LVC)
s.place('74xx:74LS08', 'U10', 'SN74LVC08APWR', 96, 82, {'4': 'P1.5', '5': 'P1.5', '6': 'SD_SCK'}, unit=2, showval=False, **LVC)
s.place('74xx:74LS08', 'U10', 'SN74LVC08APWR', 96, 88, {'9': 'P1.6', '10': 'P1.6', '8': 'SD_MOSI'}, unit=3, showval=False, **LVC)
s.place('74xx:74LS08', 'U10', 'SN74LVC08APWR', 96, 94, {'12': 'SD_MISO', '13': 'SD_MISO', '11': 'MISO_BUF'}, unit=4, showval=False, **LVC)
s.place('74xx:74LS08', 'U10', 'SN74LVC08APWR', 114.5, 105, {'14': '+3V3', '7': 'GND'}, unit=5, **LVC)
s.text('U10: 3.3 V supply, 5 V tolerant\ninputs = level shifter for\nthe card.', 106 * G, 97.6 * G, 1.0)
R('R10', '330R', 97, 100, 'MISO_BUF', 'P1.7')
sd = {'1': 'SD_DAT2', '2': 'SD_CS', '3': 'SD_MOSI', '4': '+3V3', '5': 'SD_SCK', '6': 'GND', '7': 'SD_MISO',
      '8': 'SD_DAT1', 'CD': 'SD_CD', 'SH': 'GND'}
s.place('ABN8051:DM3CS-SF', 'J6', 'microSD DM3CS-SF', 80, 104, sd, fp='ABN8051:microSD_Hirose_DM3CS-SF',
        props=im(7589), libpath=SYMLIB, stubs={'4': 7, '6': 7})
R('R11', '47k', 97, 103.5, 'SD_MISO', '+3V3'); R('R12', '47k', 97, 107, 'SD_DAT1', '+3V3')
R('R13', '47k', 97, 110.5, 'SD_DAT2', '+3V3')
C('C10', '100nF', 112, 75, '+3V3', 'GND'); C('C21', '100nF', 112, 78.5, '+3V3', 'GND')
s.place('Jumper:SolderJumper_2_Open', 'JP6', 'CD to T0', 112, 85, {'1': 'SD_CD', '2': 'T0'}, fp=FP_SJ2O)
s.text('JP6 open by default: card\ndetect to T0, low = card in', 106.5 * G, 92.3 * G, 1.0)

# ================================================================ expansion
s.box(304, 182, 410, 251, 'Headers, optional I/O decoder')
exp = {'1': '+5V', '2': '+5V', '39': 'GND', '40': 'GND', '27': 'ALE', '28': '~{PSEN}', '29': '~{RD}', '30': '~{WR}',
       '31': 'RST', '32': '~{RST}', '33': '~{INT0}', '34': '~{INT1}', '35': 'T0', '36': 'T1', '37': 'RXD', '38': 'TXD'}
for i in range(8): exp[str(3 + i)] = AD[i]
for i in range(16): exp[str(11 + i)] = A[i]
s.place('Connector_Generic:Conn_02x20_Odd_Even', 'J2', 'BUS', 125, 84, exp,
        fp='Connector_PinHeader_2.54mm:PinHeader_2x20_P2.54mm_Vertical')
gp = {'1': '+5V', '2': '+3V3', '11': 'GND', '12': 'GND'}
for i in range(8): gp[str(3 + i)] = 'P1.%d' % i
s.place('Connector_Generic:Conn_02x06_Odd_Even', 'J3', 'GPIO P1', 141, 77, gp,
        fp='Connector_PinHeader_2.54mm:PinHeader_2x06_P2.54mm_Vertical')
dec = {'1': 'A13', '2': 'A14', '3': 'A15', '4': 'GND', '5': 'GND', '6': '+5V', '16': '+5V', '8': 'GND'}
for i, p in enumerate([15, 14, 13, 12, 11, 10, 9, 7]): dec[str(p)] = '~{IO%d}' % i
s.place('74xx:74HC138', 'U7', 'MC74HC138AD', 142, 91, dec, fp='Package_SO:SOIC-16_3.9x9.9mm_P1.27mm',
        props=im(7265, Note='Optional'), draw={'5': 'N'})
s.wire(s.pinpos('74xx:74HC138', 1, '4', 142 * G, 91 * G), s.pinpos('74xx:74HC138', 1, '5', 142 * G, 91 * G))
s.place('Connector_Generic:Conn_01x08', 'J5', 'IO SELECT', 156, 78, {str(i + 1): '~{IO%d}' % i for i in range(8)},
        fp='Connector_PinHeader_2.54mm:PinHeader_1x08_P2.54mm_Vertical')
s.text('U7 optional: ~IOn is low in\n8 K block n (n x 2000h)', 150.5 * G, 87 * G, 1.0)
C('C7', '100nF', 155.5, 94, '+5V', 'GND')
s.text('User LEDs (active low)', 82 * G, 11.5 * G, 1.4, True)
for i in range(4):
    y = 15 + i * 3.5
    a = s.place('Device:LED', 'D%d' % (i + 1), 'red', 86, y, {'1': 'LED%d_K' % i, '2': 'LED_A'}, rot=180, fp=FP_LED,
                props={'LCSC': 'C84256'}, draw={'1': 'N'}, refpos=(0, -2.3), valpos=(0, 2.9), showval=False)
    b = s.place('Device:R_Small', 'R%d' % (4 + i), '1k', 91, y, {'1': 'LED%d_K' % i, '2': 'P1.%d' % i}, rot=90, fp=FP_R,
                props=lc('1k'), draw={'1': 'N'}, refpos=(0, -2.3), valpos=(0, 2.9))
    s.wire(a['1'], b['1'])
s.place('Jumper:SolderJumper_2_Bridged', 'JP5', 'LED enable', 90, 30.5, {'1': '+5V', '2': 'LED_A'}, fp=FP_SJ2B)

# mounting holes
for i in range(4):
    s.place('Mechanical:MountingHole', 'H%d' % (i + 1), 'M3', 84 + i * 5, 36, {}, fp='MountingHole:MountingHole_3.2mm_M3',
            refpos=(0, -3.3), valpos=(0, 3.3))

# power flags
def flag(net, gx, gy):
    x, y = gx * G, gy * G
    s.flag(x, y, (0, -1))
    s.wire((x, y), (x, y + G))
    if net in ('+5V', 'GND', '+3V3'):
        s.power(net, x, y + G, (0, 1))
    else:
        s.label(net, x, y + G, (0, 1))
flag('+5V', 44, 107.5); flag('GND', 47.5, 107.5); flag('VBUS', 40, 107.5)

open(os.path.join(OUT, 'ABN8051.kicad_sch'), 'w').write(s.dump())
json.dump({'nets': {k: sorted(map(list, v)) for k, v in s.model.items()},
           'comps': s.comps}, open(os.path.join(OUT, 'model.json'), 'w'), indent=1)
print('components', len(s.comps), 'nets', len(s.model))
