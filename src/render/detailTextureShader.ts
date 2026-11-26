/**
 * Stochastic texture projection for the local, physically scaled PBR tiles.
 * The two linear array textures contain four substrate layers and use the
 * worker's exact splat masks. Normals are interpreted as surface gradients,
 * rotated with their UV transforms, and projected onto the terrain surface
 * by the caller's reciprocal tangent frame.
 */
export const DETAIL_TEXTURE_GLSL = `
uniform highp sampler2DArray nhTileColor;
uniform highp sampler2DArray nhTileShape;
uniform float nhTileMeters;
uniform float nhTileReady;
uniform float nhTileAO;

struct NHTileProjection {
  vec3 tint;
  vec2 slope;
  float alpha;
  float cavity;
};
struct NHTileSurface {
  vec3 tint;
  vec3 gradient;
  float alpha;
  float cavity;
};

NHTileProjection nhTileCorner(vec2 uv, vec2 dx, vec2 dy, vec2 cell, int layer, float salt) {
  vec3 random = nhHash(vec3(cell, salt + float(layer)*17.0));
  // Keep geological bedding broadly coherent; snow retains its wind axis.
  float rotation = layer == 0 ? 1.15 : layer == 1 ? 0.75 : layer == 2 ? 0.34 : 0.0;
  float a = (random.z-0.5)*rotation;
  float c = cos(a), s = sin(a);
  mat2 turn = mat2(c,s,-s,c);
  vec2 local = turn*uv + random.xy;
  // Explicit derivatives exclude discontinuous stochastic cell offsets and
  // preserve texture mip selection at patch and material boundaries.
  vec4 pigment = textureGrad(nhTileColor, vec3(local,float(layer)), turn*dx, turn*dy);
  vec4 shape = textureGrad(nhTileShape, vec3(local,float(layer)), turn*dx, turn*dy);
  vec3 n = shape.rgb*2.0-1.0;
  // Remove the 128/255 neutral-normal quantization bias on horizontal axes.
  n.xy = (shape.rg*255.0-128.0)/127.0;
  // The stored normal is +Y toward north, while tile v increases south.
  vec2 slope = transpose(turn)*vec2(-n.x,n.y)/max(0.27,n.z);
  float variance = clamp(1.0-length(n),0.0,1.0);
  return NHTileProjection(pigment.rgb*2.0-1.0, slope,
    shape.a*2.0-1.0 + 0.32*variance, 1.0-pigment.a);
}

void nhAddProjection(inout NHTileProjection dst, NHTileProjection src, float w) {
  dst.tint += w*src.tint;
  dst.slope += w*src.slope;
  dst.alpha += w*src.alpha;
  dst.cavity += w*src.cavity;
}

// Triangular lattice: adjacent triangles share their edge vertices and
// weights. Each vertex owns a repeat offset and a fixed small rotation.
// Smooth barycentric weights avoid hard seams; texture fetches are skipped
// for negligible weights. Variance compensation retains visible structure
// in three-way transitions instead of washing the texture into a blur.
NHTileProjection nhTilePlane(vec2 uv, vec2 dx, vec2 dy, vec4 layers, float salt) {
  vec2 grid = uv/2.35;
  vec2 cell = floor(grid), f = fract(grid);
  vec2 v0, v1, v2;
  vec3 w;
  if (f.x+f.y <= 1.0) {
    v0=cell; v1=cell+vec2(1,0); v2=cell+vec2(0,1);
    w=vec3(1.0-f.x-f.y,f.x,f.y);
  } else {
    v0=cell+vec2(1,1); v1=cell+vec2(0,1); v2=cell+vec2(1,0);
    w=vec3(f.x+f.y-1.0,1.0-f.x,1.0-f.y);
  }
  w=w*w*(3.0-2.0*w);
  w/=max(dot(w,vec3(1.0)),0.0001);
  float contrast=min(1.38,inversesqrt(max(0.01,dot(w,w))));
  NHTileProjection total=NHTileProjection(vec3(0),vec2(0),0.0,0.0);
  for (int layer=0;layer<4;layer++) {
    float coverage=layers[layer];
    if (coverage <= 0.003) continue;
    NHTileProjection blended=NHTileProjection(vec3(0),vec2(0),0.0,0.0);
    if (w.x>0.002) nhAddProjection(blended,nhTileCorner(uv,dx,dy,v0,layer,salt),w.x);
    if (w.y>0.002) nhAddProjection(blended,nhTileCorner(uv,dx,dy,v1,layer,salt),w.y);
    if (w.z>0.002) nhAddProjection(blended,nhTileCorner(uv,dx,dy,v2,layer,salt),w.z);
    blended.tint*=contrast;
    blended.slope*=contrast;
    nhAddProjection(total,blended,coverage);
  }
  return total;
}

NHTileSurface nhTileTriplanar(vec3 uv, vec3 dx, vec3 dy, vec4 layers) {
  // Use the unexaggerated object-space surface orientation, independent of
  // the camera and the view-space normal map. A steep wall receives the
  // vertical projection rather than horizontally stretched grass texels.
  vec3 axis=abs(cross(dx,dy));
  axis/=max(0.00000001,max(axis.x,max(axis.y,axis.z)));
  vec3 w=axis*axis;
  w*=w;
  w=max(vec3(0.0),w-vec3(0.012));
  float total=dot(w,vec3(1.0));
  w=total>0.0001?w/total:vec3(0,1,0);
  NHTileSurface outSurface=NHTileSurface(vec3(0),vec3(0),0.0,0.0);
  if (w.x>0.0) {
    NHTileProjection a=nhTilePlane(uv.yz,dx.yz,dy.yz,layers,23.0);
    outSurface.tint+=w.x*a.tint;
    outSurface.gradient+=w.x*vec3(0,a.slope);
    outSurface.alpha+=w.x*a.alpha;
    outSurface.cavity+=w.x*a.cavity;
  }
  if (w.y>0.0) {
    NHTileProjection a=nhTilePlane(uv.xz,dx.xz,dy.xz,layers,37.0);
    outSurface.tint+=w.y*a.tint;
    outSurface.gradient+=w.y*vec3(a.slope.x,0,a.slope.y);
    outSurface.alpha+=w.y*a.alpha;
    outSurface.cavity+=w.y*a.cavity;
  }
  if (w.z>0.0) {
    NHTileProjection a=nhTilePlane(uv.xy,dx.xy,dy.xy,layers,59.0);
    outSurface.tint+=w.z*a.tint;
    outSurface.gradient+=w.z*vec3(a.slope,0);
    outSurface.alpha+=w.z*a.alpha;
    outSurface.cavity+=w.z*a.cavity;
  }
  return outSurface;
}
`;
