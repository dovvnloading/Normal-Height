import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Focus, Mountain, Palette, RotateCcw, Sun, TriangleAlert } from 'lucide-react';
import type { TerrainProject } from '../../model/types';
import { materialRanges } from '../../materials/layerSynthesis';
import { worldMaterialPreviewSource } from '../../materials/worldMaterialPreview';
import {
  WorldMaterialPreviewClient,
  worldMaterialPreviewKey,
} from '../../materials/worldMaterialPreviewClient';
import { WorldTerrainScene } from './WorldTerrainScene';
import type { WorldTerrainCameraState } from './WorldTerrainScene';
import { formatWorldDistance, worldGridBounds } from './worldViewMath';
import type { WorldLayer, WorldLayerScale, WorldRegion, WorldSnapshot } from './worldViewMath';

interface Props {
  snapshot: WorldSnapshot;
  project?: TerrainProject | null;
  rangeSnapshot?: WorldSnapshot | null;
  layer: WorldLayer;
  scale: WorldLayerScale;
  region: WorldRegion | null;
  active?: boolean;
}

/** Camera and material edits never evaluate terrain. The visible renderer lives
 * across completed terrain revisions and releases GPU resources when hidden. */
export function WorldTerrain3D({
  snapshot,
  project,
  rangeSnapshot,
  layer,
  scale,
  region,
  active = true,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<WorldTerrainScene | null>(null);
  const clientRef = useRef<WorldMaterialPreviewClient | null>(null);
  if (!clientRef.current) clientRef.current = new WorldMaterialPreviewClient();
  const savedView = useRef<WorldTerrainCameraState | null>(null);
  const [exaggeration, setExaggeration] = useState(1);
  const [wireframe, setWireframe] = useState(false);
  const [sun, setSun] = useState(315);
  const [orthographic, setOrthographic] = useState(false);
  const [materialView, setMaterialView] = useState(!!project && layer === 'relief');
  const [materialStatus, setMaterialStatus] = useState<'off' | 'loading' | 'ready' | 'error'>(
    'off',
  );
  const [materialError, setMaterialError] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const settings = useRef({ exaggeration, wireframe, sun, orthographic });
  settings.current = { exaggeration, wireframe, sun, orthographic };
  const previousLayer = useRef(layer);

  const source = useMemo(
    () => worldMaterialPreviewSource(snapshot.result, snapshot.world, snapshot.grid),
    [snapshot.result, snapshot.world, snapshot.grid],
  );
  const ranges = useMemo(() => {
    const field = (rangeSnapshot ?? snapshot).result;
    return materialRanges({
      resolution: field.width,
      height: field.heights,
      flow: field.flow,
      wear: field.wear,
      deposition: field.deposition,
    });
  }, [rangeSnapshot?.result, snapshot.result]);
  const input = useMemo(
    () =>
      project
        ? {
            source,
            ranges,
            project: {
              ...project,
              worldSize: snapshot.world.domain.width,
              heightScale: snapshot.world.domain.heightScale,
            },
          }
        : null,
    [source, ranges, project, snapshot.world.domain.width, snapshot.world.domain.heightScale],
  );
  const materialKey = input ? worldMaterialPreviewKey(input) : '';
  const currentInput = useRef(input);
  currentInput.current = input;

  useEffect(() => {
    if (previousLayer.current !== layer) setMaterialView(false);
    previousLayer.current = layer;
  }, [layer]);

  useEffect(() => {
    if (!active || !host.current) return;
    setError('');
    let scene: WorldTerrainScene | null = null;
    try {
      scene = new WorldTerrainScene(host.current, settings.current, setError, savedView.current);
      sceneRef.current = scene;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The 3D terrain view could not start.');
    }
    return () => {
      clientRef.current?.cancel();
      if (scene) {
        savedView.current = scene.cameraState();
        scene.dispose();
      }
      if (sceneRef.current === scene) sceneRef.current = null;
    };
  }, [active, retry]);

  useEffect(() => {
    try {
      sceneRef.current?.setSnapshot(snapshot);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'The sampled terrain could not be displayed.',
      );
    }
  }, [snapshot, active, retry]);
  useEffect(() => {
    try {
      sceneRef.current?.setLayer(layer, scale);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'The diagnostic layer could not be displayed.',
      );
    }
  }, [layer, scale, active, retry]);
  useEffect(() => {
    sceneRef.current?.setSelection(region);
  }, [region, active, retry]);

  useEffect(() => {
    const scene = sceneRef.current,
      input = currentInput.current;
    const client = clientRef.current!;
    let released = false;
    if (!active || !materialView || !scene || !input || error) {
      client.cancel();
      scene?.setMaterialEnabled(false);
      scene?.setMaterialStatus('off');
      setMaterialStatus('off');
      return;
    }
    scene.setMaterialEnabled(true);
    client.request(input, {
      start() {
        setMaterialStatus('loading');
        setMaterialError('');
        scene.setMaterialStatus('loading');
      },
      result(maps) {
        if (released) return;
        try {
          scene.setMaterial(maps);
          scene.setMaterialStatus('ready');
          setMaterialStatus('ready');
          setMaterialError('');
        } catch (cause) {
          const message =
            cause instanceof Error ? cause.message : 'The material could not be displayed.';
          scene.setMaterialEnabled(false);
          scene.setMaterialStatus('error');
          setMaterialStatus('error');
          setMaterialError(message);
        }
      },
      error(message) {
        if (released) return;
        scene.setMaterialEnabled(false);
        scene.setMaterialStatus('error');
        setMaterialStatus('error');
        setMaterialError(message);
      },
    });
    return () => {
      released = true;
    };
  }, [source, materialKey, materialView, active, retry, error]);

  useEffect(() => () => clientRef.current?.dispose(), []);

  return (
    <section className="wv-terrain" aria-label="World terrain view">
      <div className="wv-terrain-canvas" ref={host} />
      <div className="wv-terrain-tag">
        <Mountain size={13} />
        <span>{materialView ? 'Authored material' : 'Physical terrain'}</span>
        <span className="wv-tag-detail">
          {formatWorldDistance(worldGridBounds(snapshot.world, snapshot.grid).width)} ×{' '}
          {formatWorldDistance(worldGridBounds(snapshot.world, snapshot.grid).depth)}
        </span>
      </div>
      {error ? (
        <div className="wv-3d-error" role="alert">
          <TriangleAlert size={25} />
          <strong>3D view unavailable</strong>
          <p>{error}</p>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            <RotateCcw size={14} /> Retry 3D
          </button>
        </div>
      ) : (
        <>
          <div className="wv-terrain-tools" aria-label="Terrain view controls">
            <button
              type="button"
              title="Reset terrain camera"
              aria-label="Reset terrain camera"
              onClick={() => sceneRef.current?.reset()}
            >
              <Focus size={15} />
            </button>
            <button
              type="button"
              title="Orthographic projection"
              aria-label="Orthographic projection"
              aria-pressed={orthographic}
              onClick={() => {
                setOrthographic(!orthographic);
                sceneRef.current?.setProjection(!orthographic);
              }}
            >
              <Box size={15} />
            </button>
            <button
              type="button"
              title="Show authored PBR material"
              aria-label="Show authored PBR material"
              aria-pressed={materialView}
              disabled={!project}
              onClick={() => setMaterialView((value) => !value)}
            >
              <Palette size={15} />
            </button>
            <button
              type="button"
              title="Show terrain wireframe"
              aria-label="Show terrain wireframe"
              aria-pressed={wireframe}
              onClick={() => {
                setWireframe(!wireframe);
                sceneRef.current?.setWireframe(!wireframe);
              }}
            >
              <span className="wv-wire-icon">△</span>
            </button>
          </div>
          <div className="wv-terrain-settings">
            <label>
              <Mountain size={13} />
              <span>Vertical scale</span>
              <input
                aria-label="Terrain vertical exaggeration"
                type="range"
                min="0.25"
                max="4"
                step="0.25"
                value={exaggeration}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setExaggeration(value);
                  sceneRef.current?.setExaggeration(value);
                }}
              />
              <output>{exaggeration.toFixed(2).replace(/\.00$/, '')}×</output>
            </label>
            <label>
              <Sun size={13} />
              <span>Sun azimuth</span>
              <input
                aria-label="Terrain sun azimuth"
                type="range"
                min="0"
                max="360"
                step="5"
                value={sun}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setSun(value);
                  sceneRef.current?.setSun(value);
                }}
              />
              <output>{sun}°</output>
            </label>
          </div>
          <p className="wv-terrain-help">
            Drag to orbit · right drag to pan · scroll to zoom
            <span>
              {materialView
                ? materialStatus === 'loading'
                  ? 'Baking material…'
                  : materialError
                    ? 'Material unavailable · showing diagnostic color'
                    : 'Preview material · regional AO approximation'
                : 'Display mesh ≤ 257 × 257 samples'}
            </span>
          </p>
          {materialError && materialView && (
            <p className="wv-material-error" role="status">
              {materialError}
            </p>
          )}
        </>
      )}
    </section>
  );
}
