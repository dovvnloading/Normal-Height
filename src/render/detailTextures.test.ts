import * as THREE from 'three';
import { describe,expect,it,vi } from 'vitest';
import { createDetailTextures } from './detailTextures';
import { inspectionMinDistance,inspectionNearPlane,shouldPrepareLocalTextures } from './detailCamera';

describe('live texture resource contract',()=>{
  it('uses two independent linear four-layer texture arrays with repeat filtering',()=>{
    const resolution=16,color=new Uint8Array(resolution*resolution*16),shape=new Uint8Array(color.length);
    const textures=createDetailTextures({resolution,color,shape});
    expect(textures.color.image.data).toBe(color);
    expect(textures.shape.image.data).toBe(shape);
    for(const texture of [textures.color,textures.shape]){
      expect(texture.isDataArrayTexture).toBe(true);
      expect(texture.image.depth).toBe(4);
      expect(texture.colorSpace).toBe(THREE.NoColorSpace);
      expect(texture.wrapS).toBe(THREE.RepeatWrapping);
      expect(texture.wrapT).toBe(THREE.RepeatWrapping);
      expect(texture.minFilter).toBe(THREE.LinearMipmapLinearFilter);
      expect(texture.generateMipmaps).toBe(true);
      expect(texture.flipY).toBe(false);
    }
    const released=vi.fn();
    textures.color.addEventListener('dispose',released);
    textures.shape.addEventListener('dispose',released);
    textures.dispose();
    expect(released).toHaveBeenCalledTimes(2);
    expect(()=>createDetailTextures({resolution,color:new Uint8Array(2),shape})).toThrow('Invalid');
  });

  it('prepares local maps only at inspectable distances and permits physically closer focus',()=>{
    const metersPerUnit=8000/2.6;
    expect(inspectionMinDistance(metersPerUnit)*metersPerUnit).toBeCloseTo(8);
    expect(inspectionMinDistance(0)).toBe(0.045);
    expect(inspectionMinDistance(1e7)).toBe(0.0015);
    expect(inspectionNearPlane(1)).toBe(0.002);
    expect(inspectionNearPlane(0.003)).toBeLessThan(0.0002);
    expect(inspectionNearPlane(0.003)).toBeGreaterThanOrEqual(0.00005);
    expect(shouldPrepareLocalTextures(true,5,900,36,metersPerUnit,6)).toBe(false);
    expect(shouldPrepareLocalTextures(true,0.03,900,36,metersPerUnit,6)).toBe(true);
    expect(shouldPrepareLocalTextures(false,0.03,900,36,metersPerUnit,6)).toBe(false);
  });
});
