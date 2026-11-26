import { describe, expect, it } from 'vitest';
import { generateDetailPreview, type DetailPreviewMaps, type DetailPreviewResponse } from './detailPreview';
import { generateDetailTile } from './detailTiles';
import { DetailPreviewCache, detailPreviewKey } from './detailPreviewClient';

describe('packed live material tiles', () => {
  it('preserves per-material linear mean and shares exact exported relief normals', () => {
    const n=64, stride=n*n*4, request={ biome:'alpine' as const,seed:17 };
    const maps=generateDetailPreview(request,n);
    expect(maps.color.byteLength).toBe(stride*4);
    expect(maps.shape.byteLength).toBe(stride*4);
    for (let layer=0;layer<4;layer++) {
      const means=[0,0,0,0];
      let normalChanges=0;
      for(let p=layer*stride;p<(layer+1)*stride;p+=4) {
        for(let c=0;c<3;c++) means[c]+=maps.color[p+c]/127.5-1;
        means[3]+=maps.shape[p+3]/127.5-1;
        if(maps.shape[p]!==128 || maps.shape[p+1]!==128) normalChanges++;
      }
      for(const mean of means) expect(Math.abs(mean/(n*n))).toBeLessThan(0.035);
      expect(normalChanges).toBeGreaterThan(n*n/12);
    }
    const rock=generateDetailTile('rock',{ biome:'alpine',detailMeters:24,detailStrength:1,aoStrength:1 },17,n);
    for(let p=0;p<stride;p+=4) {
      expect([...maps.shape.slice(p,p+3)]).toEqual([...rock.normal.slice(p,p+3)]);
      expect(maps.color[p+3]).toBe(rock.orm[p]);
    }
    expect(generateDetailPreview(request,n)).toEqual(maps);
  });

  it('isolates seeds/biomes and rejects invalid work sizes', () => {
    expect(detailPreviewKey({biome:'alpine',seed:1})).not.toBe(detailPreviewKey({biome:'arid',seed:1}));
    expect(detailPreviewKey({biome:'alpine',seed:1})).not.toBe(detailPreviewKey({biome:'alpine',seed:2}));
    expect(()=>generateDetailPreview({biome:'arid',seed:1},4096)).toThrow('resolution');
  });
});

class FakeWorker {
  terminated=0;
  posts: unknown[]=[];
  onmessage: ((event: MessageEvent<DetailPreviewResponse>)=>void)|null=null;
  onerror: ((event: ErrorEvent)=>void)|null=null;
  onmessageerror: (()=>void)|null=null;
  postMessage(request:unknown){ this.posts.push(request); }
  terminate(){ this.terminated++; }
  emit(maps: DetailPreviewMaps){ this.onmessage?.({data:{type:'result',maps}} as MessageEvent<DetailPreviewResponse>); }
}
function harness() {
  const workers:FakeWorker[]=[];
  const cache=new DetailPreviewCache(()=>{
    const w=new FakeWorker();workers.push(w);return w as unknown as Worker;
  });
  return {workers,cache};
}
const packed:DetailPreviewMaps={resolution:8,color:new Uint8Array(1024),shape:new Uint8Array(1024)};
const alpine={biome:'alpine' as const,seed:1};

describe('shared close-range worker leases', () => {
  it('shares pending jobs, retains completed arrays and does not terminate active consumers', async ()=>{
    const {workers,cache}=harness();
    const a=cache.request(alpine),b=cache.request(alpine);
    expect(workers).toHaveLength(1);
    expect(a.promise).toBe(b.promise);
    a.release(); a.release();
    expect(workers[0].terminated).toBe(0);
    workers[0].emit(packed);
    expect(await b.promise).toBe(packed);
    b.release();
    const c=cache.request(alpine);
    expect(await c.promise).toBe(packed);
    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(1);
    c.release();
  });

  it('cancels abandoned work, rejects stale results and allows recovery',async ()=>{
    const {workers,cache}=harness();
    const first=cache.request(alpine);
    const rejected=expect(first.promise).rejects.toThrow('superseded');
    first.release();await rejected;
    expect(workers[0].terminated).toBe(1);
    workers[0].emit(packed);
    const second=cache.request(alpine);
    expect(workers).toHaveLength(2);
    const failed=expect(second.promise).rejects.toThrow('could not');
    workers[1].onmessage?.({data:{type:'error',message:'could not synthesize'}} as MessageEvent<DetailPreviewResponse>);
    await failed; second.release();
    const next=cache.request(alpine);
    workers[2].emit(packed);
    expect(await next.promise).toBe(packed);
    next.release();
  });

  it('bounds completed inactive cache variants to two',async ()=>{
    const {workers,cache}=harness();
    for(let seed=1;seed<=3;seed++) {
      const lease=cache.request({...alpine,seed});
      workers[seed-1].emit(packed);
      await lease.promise;lease.release();
    }
    const recent=cache.request({...alpine,seed:3});
    expect(await recent.promise).toBe(packed);recent.release();
    expect(workers).toHaveLength(3);
    const evicted=cache.request(alpine);
    expect(workers).toHaveLength(4);
    workers[3].emit(packed);await evicted.promise;evicted.release();
  });
});
