import Workspace from '../../components/workspace';
export default async function Page({searchParams}:{searchParams:Promise<{status?:string;today?:string}>}){const query=await searchParams;return <Workspace view="applications" applicationStatusFilter={query.status==='APPROVED'&&query.today==='1'?'APPROVED_TODAY':query.status}/>;}
