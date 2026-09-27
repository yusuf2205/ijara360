import Workspace from '../../components/workspace';
export default async function Page({searchParams}:{searchParams:Promise<{residentId?:string}>}) {
  const {residentId}=await searchParams;
  return <Workspace view="finance" financeResidentId={residentId}/>;
}
