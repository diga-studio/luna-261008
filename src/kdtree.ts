import { EARTH_RADIUS_M } from "./geo.js";

export interface IndexedBranch {
  institutionId: string;
  branchId: string;
  lat: number;
  lon: number;
  vehicles: ReadonlySet<string>;
  priceCents: number;
}

export interface BranchVisitor {
  (branch: IndexedBranch): void;
}

export interface ShouldContinue {
  (lowerBoundM: number): boolean;
}

const LEAF_SIZE = 8;
const LB_SAFETY = 1 - 1e-12;

interface Entry {
  branch: IndexedBranch;
  x: number;
  y: number;
  z: number;
}

interface Node {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  left: number;
  right: number;
  start: number;
  end: number;
}

function toUnit(lat: number, lon: number): [number, number, number] {
  const phi = (lat * Math.PI) / 180;
  const lambda = (lon * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  return [cosPhi * Math.cos(lambda), cosPhi * Math.sin(lambda), Math.sin(phi)];
}

function chordLowerBound(node: Node, qx: number, qy: number, qz: number): number {
  const dx = node.minX > qx ? node.minX - qx : qx > node.maxX ? qx - node.maxX : 0;
  const dy = node.minY > qy ? node.minY - qy : qy > node.maxY ? qy - node.maxY : 0;
  const dz = node.minZ > qz ? node.minZ - qz : qz > node.maxZ ? qz - node.maxZ : 0;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function arcFromUnitChord(chord: number): number {
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, chord / 2));
}

export class BranchIndex {
  private readonly entries: Entry[] = [];
  private readonly nodes: Node[] = [];

  constructor(branches: IndexedBranch[]) {
    this.entries = branches.map((branch) => {
      const [x, y, z] = toUnit(branch.lat, branch.lon);
      return { branch, x, y, z };
    });
    if (this.entries.length > 0) {
      this.buildNode(0, this.entries.length, 0);
    }
  }

  private buildNode(start: number, end: number, depth: number): number {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = start; i < end; i++) {
      const e = this.entries[i];
      if (e.x < minX) minX = e.x;
      if (e.x > maxX) maxX = e.x;
      if (e.y < minY) minY = e.y;
      if (e.y > maxY) maxY = e.y;
      if (e.z < minZ) minZ = e.z;
      if (e.z > maxZ) maxZ = e.z;
    }
    const node: Node = {
      minX,
      minY,
      minZ,
      maxX,
      maxY,
      maxZ,
      left: -1,
      right: -1,
      start,
      end,
    };
    const index = this.nodes.length;
    this.nodes.push(node);
    if (end - start <= LEAF_SIZE) {
      return index;
    }
    const axis = depth % 3;
    const key = (e: Entry): number => (axis === 0 ? e.x : axis === 1 ? e.y : e.z);
    const slice = this.entries.slice(start, end);
    slice.sort((a, b) => key(a) - key(b));
    for (let i = 0; i < slice.length; i++) {
      this.entries[start + i] = slice[i];
    }
    const mid = start + ((end - start) >> 1);
    node.left = this.buildNode(start, mid, depth + 1);
    node.right = this.buildNode(mid, end, depth + 1);
    return index;
  }

  visitByDistance(
    lat: number,
    lon: number,
    radiusM: number,
    shouldContinue: ShouldContinue,
    visit: BranchVisitor,
  ): void {
    if (this.nodes.length === 0) {
      return;
    }
    const [qx, qy, qz] = toUnit(lat, lon);
    const heapKey: number[] = [];
    const heapNode: number[] = [];
    const push = (key: number, nodeIndex: number): void => {
      heapKey.push(key);
      heapNode.push(nodeIndex);
      let i = heapKey.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heapKey[parent] <= heapKey[i]) break;
        swap(parent, i);
        i = parent;
      }
    };
    const swap = (a: number, b: number): void => {
      const tk = heapKey[a];
      heapKey[a] = heapKey[b];
      heapKey[b] = tk;
      const tn = heapNode[a];
      heapNode[a] = heapNode[b];
      heapNode[b] = tn;
    };
    const pop = (): number => {
      const top = heapNode[0];
      const lastKey = heapKey.pop() as number;
      const lastNode = heapNode.pop() as number;
      if (heapKey.length > 0) {
        heapKey[0] = lastKey;
        heapNode[0] = lastNode;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let smallest = i;
          if (l < heapKey.length && heapKey[l] < heapKey[smallest]) smallest = l;
          if (r < heapKey.length && heapKey[r] < heapKey[smallest]) smallest = r;
          if (smallest === i) break;
          swap(i, smallest);
          i = smallest;
        }
      }
      return top;
    };

    const tryPush = (nodeIndex: number): void => {
      const node = this.nodes[nodeIndex];
      const lb =
        arcFromUnitChord(chordLowerBound(node, qx, qy, qz)) * LB_SAFETY;
      if (lb <= radiusM) {
        push(lb, nodeIndex);
      }
    };

    tryPush(0);
    while (heapKey.length > 0) {
      const nodeIndex = pop();
      const node = this.nodes[nodeIndex];
      if (node.left === -1) {
        for (let i = node.start; i < node.end; i++) {
          visit(this.entries[i].branch);
        }
      } else {
        tryPush(node.left);
        tryPush(node.right);
      }
      if (heapKey.length > 0 && !shouldContinue(heapKey[0])) {
        return;
      }
    }
  }
}
