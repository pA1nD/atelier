export const meta = { name: 'Legacy', icon: 'archive', chrome: 'catalyst-chrome', eager: true }
export default function Module() {
  const [rows, setRows] = React.useState([])
  React.useEffect(() => { fetch('/api/global/legacy-data/rows').then((r) => r.json()).then(setRows) }, [])
  return <div style={{ height: '100vh' }}>{rows.length}</div>
}
