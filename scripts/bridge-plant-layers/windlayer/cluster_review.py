"""Recover only the common branch response of complete small clustered organs."""
import numpy as np
import copy
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree
from .contact_review import support_surface_contacts


def branch_field(row):
    contact=row.get('rootContact')
    return (row['primary'],row['secondary'],row['primaryAttachment'],row['secondaryAttachment'],
            tuple(contact['center'])+(contact['innerHeight'],contact['outerHeight']) if contact else None)


def complete_organ(points,faces):
    """A sphere or a two-rim tube has a complete surface; a torn leaf patch does not."""
    if len(points)<6 or len(faces)<8:
        return False
    edges=np.sort(np.vstack((faces[:,[0,1]],faces[:,[1,2]],faces[:,[2,0]])),axis=1)
    edges,incidence=np.unique(edges,axis=0,return_counts=True)
    if np.any(incidence>2):return False
    boundary=edges[incidence==1]
    euler=len(points)-len(edges)+len(faces)
    if not len(boundary):
        if euler!=2:return False
    else:
        if euler!=0:return False
        vertices,ids,degree=np.unique(boundary,return_inverse=True,return_counts=True)
        if np.any(degree!=2):return False
        endpoints=ids.reshape(-1,2)
        graph=coo_matrix((np.ones(len(endpoints)),(endpoints[:,0],endpoints[:,1])),shape=(len(vertices),len(vertices)))
        num,_=connected_components(graph,directed=False)
        if num!=2:return False
    center=points.mean(0)
    values,vectors=np.linalg.eigh((points-center).T@(points-center))
    # Closed double-sided leaf cards still have a thin, nearly planar body.
    if values[0]<.025*values[1]:return False
    along=(points-center)@vectors[:,-1]
    length=float(np.ptp(along))
    if length<.05:return False
    z0,z1=along[edges[:,0]],along[edges[:,1]]
    for fraction in (.2,.5,.8):
        z=along.min()+fraction*length
        hit=(z0<z)!=(z1<z)
        if hit.sum()<3 or np.any(incidence[hit]!=2):return False
        a,b=points[edges[hit,0]],points[edges[hit,1]]
        q=a+((z-z0[hit])/(z1[hit]-z0[hit]))[:,None]*(b-a)
        values=np.linalg.eigvalsh((q-q.mean(0)).T@(q-q.mean(0)))
        if values[1]<.035*values[2]:return False
    return True


def recover_organ_clusters(variant,rows,vertices,triangles,labels,*,template_bank=None,variant_name=None):
    """Repeated source geometry confirms the organ; local witnesses confirm its branch, without Ripple."""
    n=len(rows);face_ids=labels[triangles[:,0]]
    counts=np.bincount(face_ids,minlength=n)
    low=np.full((n,3),np.inf);high=np.full((n,3),-np.inf)
    np.minimum.at(low,labels,vertices);np.maximum.at(high,labels,vertices)
    centers=(low+high)*.5;span=np.linalg.norm(high-low,axis=1)
    floor=float(vertices[:,2].min());height=float(np.ptp(vertices[:,2]))
    possible=(counts>=8)&(counts<=128)&(span<=min(2.,.025*height))&(low[:,2]>floor+.05*height)
    if not possible.any():return []
    order=np.argsort(labels,kind='stable');ends=np.r_[0,np.bincount(labels,minlength=n).cumsum()]
    face_order=np.argsort(face_ids,kind='stable');face_ends=np.r_[0,counts.cumsum()]
    active=np.array([not row.get('review') and row.get('influence',True) for row in rows])
    valid=np.zeros(n,dtype=bool);templates={} if template_bank is None else template_bank;template_match={}
    def signature(i):
        idx=np.sort(order[ends[i]:ends[i+1]])
        faces=np.searchsorted(idx,triangles[face_order[face_ends[i]:face_ends[i+1]]])
        points=vertices[idx]
        if len(points)>32:return None
        edges=np.sort(np.vstack((faces[:,[0,1]],faces[:,[1,2]],faces[:,[2,0]])),axis=1)
        edges,incidence=np.unique(edges,axis=0,return_counts=True)
        if np.any(incidence>2):return None
        degree=np.bincount(edges.ravel(),minlength=len(points))
        centered=points-points.mean(0)
        values,vectors=np.linalg.eigh(centered.T@centered)
        dimensions=values>max(values[-1]*1e-7,1e-14)
        topology=(len(points),len(faces),int((incidence==1).sum()),tuple(sorted(degree.tolist())),int(dimensions.sum()))
        whitened=centered@vectors[:,dimensions]/np.sqrt(values[dimensions])
        first,second=np.triu_indices(len(points),1)
        distances=np.sort(np.linalg.norm(whitened[first]-whitened[second],axis=1))
        if not len(distances) or np.ptp(points,axis=0).max()<.05:return None
        ratios=np.maximum(values[:2]/max(values[-1],1e-15),1e-12)
        return topology,distances/distances[-1],ratios
    source=np.array([row.get('attachMethod') in ('support','surfaceContact','tipCluster') for row in rows])
    for i in np.flatnonzero(possible&active&source):
        result=signature(int(i))
        if result is None:continue
        topology,feature,ratios=result
        entries=templates.setdefault(topology,[])
        if not any(entry[0]==variant_name and entry[1]==int(i) for entry in entries):
            entries.append((variant_name,int(i),feature,float(span[i]),ratios))
        valid[i]=True
    trees={key:(entries,cKDTree(np.array([item[2] for item in entries]))) for key,entries in templates.items()}
    for i in np.flatnonzero(possible&~active):
        result=signature(int(i))
        if result is None or result[0] not in trees:continue
        topology,feature,ratios=result;references,tree=trees[topology]
        distances,indices=tree.query(feature,k=min(24,len(references)))
        for difference,index in zip(np.atleast_1d(distances),np.atleast_1d(indices)):
            reference_variant,reference,_,reference_span,reference_ratios=references[int(index)]
            rms=float(difference/np.sqrt(len(feature)))
            if rms>.01:break
            if not .5<=span[i]/max(reference_span,1e-10)<=2.:continue
            if np.any(ratios/reference_ratios<.25) or np.any(ratios/reference_ratios>4.):continue
            valid[i]=True;template_match[int(i)]=(reference_variant,int(reference),rms);break
    initial=valid&active
    pending=np.array([valid[i] and bool(row.get('review')) for i,row in enumerate(rows)])
    if not pending.any():return []
    owner=np.full(n,-1,dtype=np.int32);keys={};parents=[]
    for i in np.flatnonzero(initial):
        key=branch_field(rows[i]);field=keys.get(key)
        if field is None:field=len(parents);keys[key]=field;parents.append(rows[i])
        owner[i]=field
    distance=np.full(n,np.inf);distance[initial]=0.
    witnesses={int(i):(int(i),) for i in np.flatnonzero(initial)}
    reached=initial.copy();recovered=[]
    size=np.ptp(vertices,axis=0)
    stems=[row for i,row in enumerate(rows) if active[i] and not row['terminal'] and counts[i]>=8 and row.get('attachMethod')=='support']
    if stems:
        probe_ids=np.flatnonzero(pending[labels])
        point_tolerance=np.clip(.25*span[labels[probe_ids]],.02,.15)
        distances,owners,identities=support_surface_contacts(vertices[probe_ids],3*point_tolerance,
            vertices,triangles,labels,stems,.15,point_tolerances=point_tolerance,identity_key=branch_field)
        offsets=np.r_[0,np.bincount(labels[probe_ids],minlength=n).cumsum()]
        permutation=np.argsort(labels[probe_ids],kind='stable')
        probe_ids=probe_ids[permutation];distances=distances[permutation];owners=owners[permutation];point_tolerance=point_tolerance[permutation]
        stem_by_field={branch_field(row):row for row in stems}
        minimum=np.asarray(variant['frame']['bboxMinCm'])
        frame_size=np.asarray(variant['frame']['sizeCm'])
        def saturated(points,axis):
            start=minimum+frame_size*np.asarray(axis['base'])
            delta=frame_size*(np.array(axis['tip'])-axis['base'])
            return np.min((points-start)@delta/max(delta@delta,1e-10))>=1.
        for i in np.flatnonzero(pending):
            start,stop=offsets[i:i+2]
            close=distances[start:stop]<=point_tolerance[start:stop]
            local=np.flatnonzero(close)
            fields=set(owners[start:stop][close].tolist())
            if len(local)<3 or len(fields)!=1 or -1 in fields:continue
            field_id=fields.pop();parent=stem_by_field[identities[field_id]]
            target=copy.deepcopy(parent);target['island']=int(i)
            idx=order[ends[i]:ends[i+1]]
            if target['primaryAttachment']<0 and saturated(vertices[idx],variant['primaryAxes'][target['primary']]):target['primaryAttachment']=1.
            if target['secondary']>=0 and target['secondaryAttachment']<0 and saturated(vertices[idx],variant['secondaryAxes'][target['secondary']]):target['secondaryAttachment']=1.
            key=branch_field(target);field=keys.get(key)
            if field is None:field=len(parents);keys[key]=field;parents.append(target)
            row=rows[i]
            for name in ('primary','secondary','primaryAttachment','secondaryAttachment','blade'):row[name]=target[name]
            if 'rootContact' in target:row['rootContact']=copy.deepcopy(target['rootContact'])
            else:row.pop('rootContact',None)
            row.update(review=False,influence=True,terminal=False,layers=['Shared','Branch1']+(['Branch2'] if row['secondary']>=0 else []),attachMethod='clusterBranch')
            for name in ('unassigned','unplacedSupport','syntheticAxis','parentUnit','tipCluster'):row.pop(name,None)
            chosen=start+local[np.argsort(distances[start:stop][close])[:3]]
            vertex_witnesses=probe_ids[chosen].astype(int).tolist()
            witnesses[int(i)]=tuple(n+j for j in vertex_witnesses)
            reached[i]=True;initial[i]=True;pending[i]=False;owner[i]=field;distance[i]=0.
            recovered.append(dict(island=int(i),sourceIsland=int(parent['island']),originalWitnesses=[],
                stemContactWitnessVertices=vertex_witnesses,jointDistanceCm=float(distances[chosen].max()),
                distanceCm=0.,terminal=False,templateVariant=template_match[int(i)][0],
                templateIsland=template_match[int(i)][1],templateRms=template_match[int(i)][2],wave=-1))
    original_ids=np.flatnonzero(initial)
    if not len(original_ids):return []
    original_tree=cKDTree(centers[original_ids])
    limits=[]
    for parent in parents:
        axis=variant['secondaryAxes'][parent['secondary']] if parent['secondary']>=0 else variant['primaryAxes'][parent['primary']]
        length=float(np.linalg.norm(size*(np.array(axis['tip'])-axis['base'])))
        limits.append(min(40.,.5*height,max(length,1.)))
    for wave in range(64):
        have=np.flatnonzero(reached);targets=np.flatnonzero(pending)
        if not len(targets):break
        tree=cKDTree(centers[have])
        neighbor_dist,neighbor_index=tree.query(centers[targets],k=min(24,len(have)))
        if neighbor_dist.ndim==1:neighbor_dist=neighbor_dist[:,None];neighbor_index=neighbor_index[:,None]
        proposals=[]
        for k,i in enumerate(targets):
            radius=float(np.clip(3*span[i],.15,1.5))
            near=have[neighbor_index[k][neighbor_dist[k]<=radius]]
            if len(near)<3:continue
            fields=set(owner[near].tolist())
            if len(fields)!=1:continue
            field=fields.pop()
            # Original competing parents remain visible even after an advancing front grows dense.
            original=original_ids[original_tree.query_ball_point(centers[i],radius)]
            if any(owner[j]!=field for j in original):continue
            roots=sorted({root for j in near for root in witnesses[int(j)]})
            if len(roots)<3:continue
            best=int(near[np.argmin(distance[near]+np.linalg.norm(centers[near]-centers[i],axis=1))])
            path=float(distance[best]+np.linalg.norm(centers[best]-centers[i]))
            if path>limits[field]:continue
            proposals.append((int(i),field,path,tuple(roots[:8]),best,radius))
        if not proposals:break
        for i,field,path,roots,best,radius in proposals:
            parent=parents[field];row=rows[i]
            for key in ('primary','secondary','primaryAttachment','secondaryAttachment','blade'):
                row[key]=parent[key]
            if 'rootContact' in parent:row['rootContact']=dict(parent['rootContact'])
            else:row.pop('rootContact',None)
            row.update(review=False,influence=True,terminal=False,
                layers=['Shared','Branch1']+(['Branch2'] if row['secondary']>=0 else []),attachMethod='clusterBranch')
            for key in ('unassigned','unplacedSupport','syntheticAxis','parentUnit','tipCluster'):row.pop(key,None)
            owner[i]=field;distance[i]=path;witnesses[i]=roots;reached[i]=True;pending[i]=False
            recovered.append(dict(island=i,sourceIsland=int(parent['island']),clusterParentIsland=best,
                originalWitnesses=[root for root in roots if root<n],stemContactWitnessVertices=[root-n for root in roots if root>=n],
                distanceCm=path,neighborhoodRadiusCm=radius,wave=wave,
                terminal=False,templateVariant=template_match[i][0],templateIsland=template_match[i][1],templateRms=template_match[i][2]))
    return recovered
