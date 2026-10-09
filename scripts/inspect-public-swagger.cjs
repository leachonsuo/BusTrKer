// Reads only the public, embedded Swagger contract. Does not access credentials or call an API.
async function main() {
  const dataId = process.argv[2] ?? '15157601'
  if (!['15157601', '15098533', '15098529'].includes(dataId)) throw new Error('Unsupported official dataset ID')
  const response = await fetch(`https://www.data.go.kr/data/${dataId}/openapi.do`, { signal: AbortSignal.timeout(10000) })
  const html = await response.text()
  const embedded = /const swaggerJson = `([\s\S]*?)`;/u.exec(html)?.[1]
  if (!response.ok || !embedded) throw new Error('Official embedded Swagger unavailable')
  const spec = JSON.parse(embedded)
  const operations = Object.entries(spec.paths ?? {}).map(([path, methods]) => ({
    path, pathParameters: (methods.parameters ?? []).map((parameter) => ({ name: parameter.name, in: parameter.in, required: parameter.required, type: parameter.type, description: parameter.name === 'type' ? parameter.description : undefined })),
    methods: Object.entries(methods).filter(([method]) => method !== 'parameters').map(([method, entry]) => ({
      method, operationId: entry.operationId ?? null,
      parameters: (entry.parameters ?? []).map((parameter) => ({ name: parameter.name, in: parameter.in, required: parameter.required, type: parameter.type })),
      responseFields: Object.keys(entry.responses?.['200']?.schema?.properties ?? {}),
      itemFields: Object.keys(entry.responses?.['200']?.schema?.properties?.body?.properties?.items?.properties?.item?.properties ?? {}),
      gpsFieldDescriptions: path === '/rtm_loc_info' ? Object.fromEntries(['gthrDt', 'totDt', 'oprDrct', 'lat', 'lot'].map((field) =>
        [field, entry.responses?.['200']?.schema?.properties?.body?.properties?.items?.properties?.item?.properties?.[field]?.description ?? null])) : undefined,
    })),
  }))
  process.stdout.write(JSON.stringify({ dataId, host: spec.host, basePath: spec.basePath, schemes: spec.schemes, definitions: Object.keys(spec.definitions ?? {}), operations }) + '\n')
}
main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
