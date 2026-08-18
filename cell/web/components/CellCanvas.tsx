"use client";
import CellGraph from "./CellGraph";
import NodesPanel from "./NodesPanel";
import AikoPanel from "./AikoPanel";

export default function CellCanvas({ active, onPickCell, cells, nodesOpen, onCloseNodes, aikoOpen, onCloseAiko, onFired }: {
  active: string;
  onPickCell: (p: string) => void;
  cells: any[];
  nodesOpen: boolean;
  onCloseNodes: () => void;
  aikoOpen: boolean;
  onCloseAiko: () => void;
  onFired?: () => void;
}) {
  return (
    <>
      <CellGraph cellPath={active} onPickCell={onPickCell} onFired={onFired} />
      {nodesOpen && <NodesPanel cells={cells} active={active} onPick={(p) => { onPickCell(p); onCloseNodes(); }} onClose={onCloseNodes} />}
      {aikoOpen && <AikoPanel activeCell={active} onClose={onCloseAiko} />}
    </>
  );
}
