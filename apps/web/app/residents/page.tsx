import Workspace from '../../components/workspace';
export default async function Page({searchParams}:{searchParams:Promise<{filter?:string}>}) {
  const {filter} = await searchParams;
  return <Workspace view="residents" residentFilter={filter} />;
}
