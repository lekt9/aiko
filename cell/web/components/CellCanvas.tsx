"use client";
import CellGraph from "./CellGraph";
import NodesPanel from "./NodesPanel";
import AikoPanel from "./AikoPanel";
import EditPanel from "./EditPanel";

export default function CellCanvas({ active, onPickCell, cells, nodesOpen, onCloseNodes, aikoOpen, onCloseAiko, editOpen, onCloseEdit, onFired, onCellsChanged }: {
  active: string;
  onPickCell: (p: string) => void;
  cells: any[];
  nodesOpen: boolean;
  onCloseNodes: () => void;
  aikoOpen: boolean;
  onCloseAiko: () => void;
  editOpen: boolean;
  onCloseEdit: () => void;
  onFired?: () => void;
  onCellsChanged?: () => void;
}) {
  return (
    <>
      <CellGraph cellPath={active} onPickCell={onPickCell} onFired={onFired} />
      {nodesOpen && (
        <NodesPanel
          cells={cells}
          active={active}
          onPick={(p) => { onPickCell(p); onCloseNodes(); }}
          onCreated={(rel) => { onCellsChanged?.(); onPickCell(rel); onCloseNodes(); }}
          onClose={onCloseNodes}
        />
      )}
      {aikoOpen && <AikoPanel activeCell={active} onClose={onCloseAiko} onCreated={(rel) => { onCellsChanged?.(); onPickCell(rel); }} />}
      {editOpen && <EditPanel cellPath={active} onClose={onCloseEdit} onSaved={() => onCellsChanged?.()} />}
    </>
  );
}
