import Workspace from '../../components/workspace';
export default async function Page({searchParams}:{searchParams:Promise<{filter?:string;q?:string}>}) {
  const {filter,q} = await searchParams;
  return <Workspace view="residents" residentFilter={filter} residentQuery={q} />;
}
