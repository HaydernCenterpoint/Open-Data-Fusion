import type { AssetNode } from "../types";

export const assetTree: AssetNode[] = [
  {
    id: "north-plant",
    name: "North Plant",
    kind: "site",
    children: [
      {
        id: "cooling-water",
        name: "Cooling Water System",
        kind: "system",
        children: [
          { id: "p-101", name: "Pump P-101", kind: "pump" },
          { id: "p-102", name: "Pump P-102", kind: "pump" },
          { id: "hx-201", name: "Heat Exchanger HX-201", kind: "exchanger" },
          { id: "ct-301", name: "Cooling Tower CT-301", kind: "tower" },
          { id: "v-401", name: "Valve V-401", kind: "valve" },
          { id: "fm-501", name: "Flow Meter FM-501", kind: "meter" },
        ],
      },
      { id: "chilled-water", name: "Chilled Water System", kind: "system", children: [] },
      { id: "boiler", name: "Boiler System", kind: "boiler", children: [] },
      { id: "utility", name: "Utility System", kind: "utility", children: [] },
    ],
  },
];

export const pressureValues = [
  107, 109, 110, 106, 108, 102, 105, 109, 111, 110, 111, 108,
  103, 102, 107, 109, 109, 111, 106, 108, 112, 117, 110, 108,
  112, 108, 109, 107, 102, 100, 105, 101, 102, 97, 99, 94,
  104, 96, 98, 103, 105, 107, 102, 106, 108, 107, 110, 109,
  105, 102, 104, 108, 110, 105, 107, 110, 111, 112,
];

export const timeSeries = [
  { name: "Pressure", meta: "psi · OSIsoft PI", value: "111.2 psi" },
  { name: "Discharge Flow", meta: "gpm · OSIsoft PI", value: "482 gpm" },
  { name: "Motor Current", meta: "A · OSIsoft PI", value: "68.4 A" },
];

export const documents = [
  { name: "P-101 O&M Manual", meta: "PDF · 2.4 MB" },
  { name: "P-101 Performance Curve", meta: "PDF · 1.1 MB" },
];

export const relations = [
  { from: "P-101", to: "V-401", type: "Discharges to", direction: "right" },
  { from: "P-101", to: "HX-201", type: "Feeds", direction: "right" },
  { from: "P-101", to: "FM-501", type: "Measured by", direction: "left" },
  { from: "P-101", to: "CT-301", type: "Supports", direction: "right" },
];

export const searchableItems = [
  { id: "p-101", title: "Pump P-101", meta: "Asset · Cooling Water System" },
  { id: "p-102", title: "Pump P-102", meta: "Asset · Cooling Water System" },
  { id: "pressure", title: "P-101 Pressure", meta: "Time series · OSIsoft PI" },
  { id: "manual", title: "P-101 O&M Manual", meta: "Document · PDF" },
];
