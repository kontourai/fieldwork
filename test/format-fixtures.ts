import type { FieldworkSourceAdapters } from "../src/api-contracts.js";

export const formatPdfText = "Cover\nStatus: Active\n";
export const formatStatusRange = { start: 6, end: 20 } as const;
export const formatPdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
export const formatImageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
export const formatFailingImageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

export const formatSourceAdapters: FieldworkSourceAdapters = {
  pdf: {
    id: "format-fixture-pdf-v1",
    extract: {
      extract: () => ({
        text: formatPdfText,
        pageOffsets: [0, 6],
        layout: {
          pages: [
            { pageNumber: 1, width: 612, height: 792, unit: "points" },
            { pageNumber: 2, width: 612, height: 792, unit: "points" },
          ],
          elements: [{
            kind: "table-cell",
            providerType: "fixture-cell",
            pageNumber: 2,
            range: formatStatusRange,
            bounds: { x: 72, y: 96, width: 180, height: 18 },
          }],
          tables: [{
            pageNumber: 2,
            bounds: { x: 64, y: 88, width: 196, height: 34 },
            cells: [{
              rowIndex: 0,
              columnIndex: 0,
              range: formatStatusRange,
              bounds: { x: 72, y: 96, width: 180, height: 18 },
            }],
          }],
        },
      }),
    },
  },
  image: {
    id: "format-fixture-ocr-v1",
    extract: {
      extract: async (bytes) => {
        if (bytes[0] === formatFailingImageBytes[0]) {
          throw new Error("synthetic private OCR diagnostic");
        }
        return {
          text: "Status: Active",
          warnings: ["OCR output requires review"],
        };
      },
    },
  },
};
