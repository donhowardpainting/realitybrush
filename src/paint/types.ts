import * as THREE from 'three';

/** Paint identifiers. `None` doubles as the solvent (it strips paint). */
export enum Paint {
  None = 0,
  Purple = 1,
  Blue = 2,
  Green = 3,
  Yellow = 4,
  Red = 5,
}

export interface PaintInfo {
  id: Paint;
  key: string;
  name: string;
  verb: string;
  hex: number;
  css: string;
  color: THREE.Color;
  rgb: [number, number, number];
}

function info(id: Paint, key: string, name: string, verb: string, hex: number): PaintInfo {
  const color = new THREE.Color(hex);
  return {
    id, key, name, verb, hex,
    css: '#' + hex.toString(16).padStart(6, '0'),
    color,
    rgb: [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255],
  };
}

export const PAINTS: Record<number, PaintInfo> = {
  [Paint.None]: info(Paint.None, 'solvent', 'SOLVENT', 'Strips paint', 0xdfe8ee),
  [Paint.Purple]: info(Paint.Purple, 'purple', 'ANTI-GRAVITY', 'Movable objects float', 0xa544ff),
  [Paint.Blue]: info(Paint.Blue, 'blue', 'ICE', 'Surfaces lose friction', 0x35c8ff),
  [Paint.Green]: info(Paint.Green, 'green', 'GROWTH', 'Fertile surfaces grow', 0x4cff62),
  [Paint.Yellow]: info(Paint.Yellow, 'yellow', 'BOUNCE', 'Surfaces become springs', 0xffd21f),
  [Paint.Red]: info(Paint.Red, 'red', 'ENERGY', 'Powers machinery', 0xff3030),
};

export const PAINT_ORDER: Paint[] = [Paint.Purple, Paint.Blue, Paint.Green, Paint.Yellow, Paint.Red];
