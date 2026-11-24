# Third-party notices

## FastNoiseLite

Normal Height Studio v3 includes the unmodified official TypeScript implementation
of FastNoiseLite 1.1.1 in
`src/engine/noiseStudio/vendor/FastNoiseLite.ts`.

- Upstream: <https://github.com/Auburn/FastNoiseLite>
- Pinned commit: `785f37a9ad76e283586a379675085f2063ae03f7`
- Source: `JavaScript/src/FastNoiseLite.ts`
- Source SHA-256: `67c13e35897c5cb3a8ea19bfa39ab9ec240bb887c7c79a58102488c15bdc1aaf`
- JavaScript/TypeScript port: Patrick U (snowfoxsh) and Simon Paris.
- The independently differentiated Perlin interpolant in
  `src/engine/noiseStudio/perlin.ts` uses the same gradient geometry, hashing
  constants and normalization, and is also covered by this attribution.

The file's original copyright and permission notice is preserved verbatim.

### MIT License

Copyright (c) 2023 Jordan Peck (jordan.me2@gmail.com)

Copyright (c) 2023 Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Mathematical references

The Gabor, cellular, and derivative-guided fractal extensions are independent
implementations of mathematical descriptions. No GPL Blender source or code with
unverified licensing was copied into these modules. Their primary references,
adaptations, and numerical limitations are documented in
[`docs/NOISE_RESEARCH.md`](docs/NOISE_RESEARCH.md).
