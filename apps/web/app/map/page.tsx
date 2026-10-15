import Workspace from '../../components/workspace';
export default async function Page({searchParams}:{searchParams:Promise<{resident?:string}>}){const {resident}=await searchParams;return <Workspace view="map" residentId={resident}/>;}
