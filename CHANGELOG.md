# Changelog

## Unreleased

Breaking: new runs write storage profile v2 and export ReviewedExport v2 with Survey 9 policy and attestations. Existing v1 runs retain their historical export and require an explicit upgrade before saving more decisions. Consumers can use `reviewedExportSchema` for the strict v1/v2 union, or `reviewedExportV1Schema` and `reviewedExportV2Schema` for a specific version.
