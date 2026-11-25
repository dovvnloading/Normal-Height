import { CanvasTexture, Color, LinearFilter, Mesh, ShaderMaterial, SRGBColorSpace, Vector2 } from 'three';
import type { BufferGeometry } from 'three';
import type { BrushFeedback } from './brushFeedback';

/** Depth-tested overlay shares the live adaptive geometry with its parent.
 * Both the ring and coverage follow the terrain exactly, including cliffs. */
export class MaterialBrushOverlay {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  private readonly texture: CanvasTexture;
  private readonly guideTexture: CanvasTexture;
  private readonly unsubscribe: () => void;

  constructor(geometry: BufferGeometry, feedback: BrushFeedback, redraw: () => void) {
    this.texture = new CanvasTexture(feedback.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = LinearFilter;
    this.guideTexture = new CanvasTexture(feedback.guideCanvas);
    this.guideTexture.colorSpace = SRGBColorSpace;
    this.guideTexture.generateMipmaps = false;
    this.guideTexture.minFilter = LinearFilter;
    const uniforms = {
      coverage: { value: this.texture },
      guide: { value: this.guideTexture },
      center: { value: new Vector2(-2, -2) },
      radius: { value: 0.01 }, hardness: { value: 0.5 }, ink: { value: new Color() },
      aspect: { value: 1 }, angle: { value: 0 }, strength: { value: 1 },
      falloffVisible: { value: true }, coverageVisible: { value: true },
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
        uniform float radius, hardness, aspect, angle, strength;
        uniform bool falloffVisible, coverageVisible;
        uniform sampler2D coverage, guide;
        uniform vec3 ink;
        void main() {
          vec4 paint = coverageVisible ? texture2D(coverage, tile) : vec4(0.);
          vec4 mask = texture2D(guide, tile);
          paint.rgb = mix(paint.rgb, mask.rgb, mask.a / max(.001, paint.a + mask.a));
          paint.a = max(paint.a, mask.a);
          vec2 delta = vec2(tile.x, 1. - tile.y) - center;
          float c = cos(angle), s = sin(angle);
          vec2 local = vec2(c * delta.x + s * delta.y, -s * delta.x + c * delta.y);
          float d = length(vec2(local.x, local.y / max(.05, aspect)));
          float aa = max(fwidth(d), .000001);
          float r = abs(d - radius) / aa;
          float rim = 1. - smoothstep(.5, 1.35, r);
          float inner = falloffVisible ? (1. - smoothstep(.3, 1., abs(d - radius * hardness) / aa)) * .55 : 0.;
          float feather = falloffVisible ? (1. - smoothstep(radius * hardness, max(radius * hardness + .000001, radius), d)) * strength * .06 : 0.;
          float edge = 1. - smoothstep(1.3, 2.2, r);
          vec3 base = mix(paint.rgb, ink, inner);
          base = mix(base, vec3(.035), edge);
          base = mix(base, vec3(.97), rim);
          float alpha = max(feather, max(paint.a, max(inner, edge)));
          if (alpha < .004) discard;
          gl_FragColor = vec4(base, alpha);
          #include <colorspace_fragment>
        }`,
    }));
    this.mesh.name = 'Material brush footprint';
    this.mesh.renderOrder = 7;
    let revision = -1;
    let guideRevision = -1;
    this.unsubscribe = feedback.subscribe(() => {
      const point = feedback.cursor;
      this.mesh.visible = !!point || feedback.hasMarksFor('scene') || feedback.guideRevision > 0;
      uniforms.center.value.set(point?.u ?? -2, point?.v ?? -2);
      uniforms.radius.value = feedback.settings.radius;
      uniforms.hardness.value = feedback.settings.hardness;
      uniforms.aspect.value = feedback.settings.aspect ?? 1;
      uniforms.angle.value = (feedback.settings.angle ?? 0) * Math.PI / 180;
      uniforms.strength.value = feedback.settings.strength;
      uniforms.falloffVisible.value = feedback.showFalloff;
      uniforms.coverageVisible.value = feedback.hasMarksFor('scene') && !feedback.liveFor('scene');
      uniforms.ink.value.set(feedback.colors[feedback.settings.layer]);
      if (revision !== feedback.revision) {
        this.texture.needsUpdate = true;
        revision = feedback.revision;
      }
      if (guideRevision !== feedback.guideRevision) {
        this.guideTexture.needsUpdate = true;
        guideRevision = feedback.guideRevision;
      }
      redraw();
    });
  }

  dispose() {
    this.unsubscribe();
    this.mesh.removeFromParent();
    this.mesh.material.dispose();
    this.texture.dispose();
    this.guideTexture.dispose();
  }
}
