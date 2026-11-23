import { CanvasTexture, Color, LinearFilter, Mesh, ShaderMaterial, SRGBColorSpace, Vector2 } from 'three';
import type { BufferGeometry } from 'three';
import { BRUSH_COLORS, type BrushFeedback } from './brushFeedback';

/** Depth-tested overlay shares the live adaptive geometry with its parent.
 * Both the ring and coverage follow the terrain exactly, including cliffs. */
export class MaterialBrushOverlay {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  private readonly texture: CanvasTexture;
  private readonly unsubscribe: () => void;

  constructor(geometry: BufferGeometry, feedback: BrushFeedback, redraw: () => void) {
    this.texture = new CanvasTexture(feedback.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = LinearFilter;
    const uniforms = {
      coverage: { value: this.texture },
      center: { value: new Vector2(-2, -2) },
      radius: { value: 0.01 }, hardness: { value: 0.5 }, ink: { value: new Color() },
    };
    this.mesh = new Mesh(geometry, new ShaderMaterial({
      uniforms, transparent: true, depthWrite: false, polygonOffset: true,
      polygonOffsetFactor: -1, polygonOffsetUnits: -1, toneMapped: false,
      vertexShader: `
        varying vec2 tile;
        void main() {
          tile = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
        }`,
      fragmentShader: `
        varying vec2 tile;
        uniform vec2 center;
        uniform float radius, hardness;
        uniform sampler2D coverage;
        uniform vec3 ink;
        void main() {
          vec4 paint = texture2D(coverage, tile);
          float d = distance(vec2(tile.x, 1. - tile.y), center);
          float aa = max(fwidth(d), .000001);
          float r = abs(d - radius) / aa;
          float rim = 1. - smoothstep(.5, 1.35, r);
          float inner = (1. - smoothstep(.3, 1., abs(d - radius * hardness) / aa)) * .55;
          float edge = 1. - smoothstep(1.3, 2.2, r);
          vec3 base = mix(paint.rgb, ink, inner);
          base = mix(base, vec3(.035), edge);
          base = mix(base, vec3(.97), rim);
          float alpha = max(paint.a, max(inner, edge));
          if (alpha < .004) discard;
          gl_FragColor = vec4(base, alpha);
          #include <colorspace_fragment>
        }`,
    }));
    this.mesh.name = 'Material brush footprint';
    this.mesh.renderOrder = 7;
    let revision = -1;
    this.unsubscribe = feedback.subscribe(() => {
      const point = feedback.cursor;
      this.mesh.visible = !!point || feedback.hasMarks;
      uniforms.center.value.set(point?.u ?? -2, point?.v ?? -2);
      uniforms.radius.value = feedback.settings.radius;
      uniforms.hardness.value = feedback.settings.hardness;
      uniforms.ink.value.set(BRUSH_COLORS[feedback.settings.layer]);
      if (revision !== feedback.revision) {
        this.texture.needsUpdate = true;
        revision = feedback.revision;
      }
      redraw();
    });
  }

  dispose() {
    this.unsubscribe();
    this.mesh.removeFromParent();
    this.mesh.material.dispose();
    this.texture.dispose();
  }
}
