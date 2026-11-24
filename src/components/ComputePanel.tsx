import { Cpu, Download, Trash2 } from 'lucide-react';
import { Modal } from './Modal';
import { downloadBlob } from '../model/project';
import { BUILD_INFO } from '../model/buildInfo';
import type { EvaluationResult, TerrainProject } from '../model/types';
import './WorldStudio.css';

const memory = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`;

export function ComputePanel({
  project,
  result,
  stale,
  onClear,
  onClose,
}: {
  project: TerrainProject;
  result: EvaluationResult | null;
  stale: boolean;
  onClear: () => void;
  onClose: () => void;
}) {
  const data = result?.diagnostics;
  return (
    <Modal
      title="Compute diagnostics"
      eyebrow="PERSISTENT CPU ENGINE"
      onClose={onClose}
      className="compute-modal"
    >
      <div className="compute-body">
        <p>
          The worker retains completed, immutable graph fields between builds. Downstream edits can
          reuse upstream work. Cancelling an active legacy solver terminates that worker and
          releases its cache.
        </p>
        {stale && (
          <div className="world-note">
            These measurements describe the last complete build. The current graph has pending
            changes.
          </div>
        )}
        {data ? (
          <>
            <div className="compute-cards">
              <div>
                <small>Build time</small>
                <strong>
                  {result.duration.toFixed(1)} <em>ms</em>
                </strong>
              </div>
              <div>
                <small>Reused / computed</small>
                <strong>
                  {data.cacheHits} <em>/ {data.cacheMisses}</em>
                </strong>
              </div>
              <div>
                <small>Cached fields</small>
                <strong>{memory(data.cacheBytes)}</strong>
              </div>
            </div>
            <div className="compute-budget">
              <Cpu size={14} />
              <span>CPU reference</span>
              <span>Cache budget {memory(data.cacheBudgetBytes)}</span>
              <span>Working estimate {memory(data.estimatedWorkingBytes)}</span>
              <span>{data.evictions} evictions</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Result</th>
                  <th>Reason</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {data.nodes.map((node) => (
                  <tr key={node.nodeId}>
                    <td>
                      {project.graph.nodes.find((n) => n.id === node.nodeId)?.label ?? node.nodeId}
                    </td>
                    <td>
                      <span className={`compute-node-state ${node.status}`}>
                        {node.status === 'hit' ? 'Reused' : 'Computed'}
                      </span>
                    </td>
                    <td>{node.reason.replaceAll('-', ' ')}</td>
                    <td>{node.durationMs.toFixed(2)} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <div className="world-note">
            Build a terrain to view timing, memory, and cache measurements.
          </div>
        )}
        <div className="compute-actions">
          <button className="button secondary" onClick={onClear}>
            <Trash2 size={14} />
            Clear cache
          </button>
          <button
            className="button primary"
            disabled={!data}
            onClick={() =>
              downloadBlob(
                new Blob(
                  [
                    JSON.stringify(
                      {
                        application: 'Normal Height',
                        build: BUILD_INFO,
                        resolution: result?.field.resolution,
                        duration: result?.duration,
                        stale,
                        diagnostics: data,
                      },
                      null,
                      2,
                    ),
                  ],
                  { type: 'application/json' },
                ),
                'normal-height-compute-report.json',
              )
            }
          >
            <Download size={14} />
            Download report
          </button>
        </div>
      </div>
    </Modal>
  );
}
