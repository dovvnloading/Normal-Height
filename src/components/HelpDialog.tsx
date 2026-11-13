import { BookOpen, Command, GitBranch, MousePointer2, Droplets, Download } from 'lucide-react';
import { Modal } from './Modal';
export function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="A landscape, one step at a time."
      eyebrow="NORMAL HEIGHT / FIELD GUIDE"
      onClose={onClose}
      className="help-modal"
    >
      <div className="modal-body">
        <p className="help-intro">
          Build a process you can see. Every node transforms real elevation data, and every seed
          makes that process repeatable.
        </p>
        <div className="help-steps">
          {[
            [
              MousePointer2,
              '01 · Shape',
              'Start with a landscape, or add a Mountain range or Procedural noise node. Select a node to adjust its parameters.',
            ],
            [
              GitBranch,
              '02 · Connect',
              'Drag from a labeled output port to an input. The graph runs from sources toward Terrain output. Use a Blend node to combine two fields.',
            ],
            [
              Droplets,
              '03 · Erode',
              'Hydraulic erosion moves sediment downhill. Try Flow, Wear, and Deposit in 2D to understand the result. Thermal weathering settles loose slopes.',
            ],
            [
              Download,
              '04 · Take it with you',
              'Save a project to preserve the graph. Export reruns the graph at your chosen grid size and writes a precise heightmap.',
            ],
          ].map(([Icon, title, copy]) => {
            const Component = Icon as typeof BookOpen;
            return (
              <section key={String(title)}>
                <Component size={19} />
                <div>
                  <h3>{String(title)}</h3>
                  <p>{String(copy)}</p>
                </div>
              </section>
            );
          })}
        </div>
        <h3 className="shortcuts-title">
          <Command size={14} />
          Keyboard & navigation
        </h3>
        <div className="shortcut-grid">
          {[
            ['Undo / redo', '⌘ / Ctrl Z · Shift Z'],
            ['Save project', '⌘ / Ctrl S'],
            ['Duplicate node', '⌘ / Ctrl D'],
            ['Open node palette', '⌘ / Ctrl K'],
            ['Find a node', '/'],
            ['Delete selection', 'Delete / Backspace'],
            ['Fit graph', 'Home'],
            ['Graph pan', 'Middle / right drag'],
            ['Graph selection', 'Shift + drag'],
            ['3D orbit / pan', 'Left / right drag'],
            ['Focus viewport', 'F (over preview)'],
            ['Zoom', 'Scroll wheel'],
          ].map(([action, key]) => (
            <div key={action}>
              <span>{action}</span>
              <kbd>{key}</kbd>
            </div>
          ))}
        </div>
        <p className="help-note">
          Each session opens a fresh landscape. Your work autosaves in this browser; use Restore
          last session to reopen it, or download a project file to keep a portable copy.
          The simulation is an artistic particle erosion model; dimensions and map precision are
          explicit, while rainfall controls are not calibrated to geological time.
        </p>
      </div>
      <footer className="modal-footer">
        <a
          href="https://github.com/dovvnloading/Normal-Height"
          target="_blank"
          rel="noreferrer"
          className="text-link"
        >
          Source & documentation ↗
        </a>
        <button className="button primary" onClick={onClose}>
          Back to the landscape
        </button>
      </footer>
    </Modal>
  );
}
