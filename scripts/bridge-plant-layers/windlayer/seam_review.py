"""Fill scan gaps through measured edge seams, with competing wind fields kept separate."""
import heapq
import numpy as np
from scipy.sparse import coo_matrix
from scipy.spatial import cKDTree

from .surface_fragments import inherit_surface


def wind_field(row):
    contact = row.get('rootContact')
    return (row['primary'], row['secondary'], row['primaryAttachment'], row['secondaryAttachment'],
            row['terminal'], tuple(map(tuple,row['blade'])) if row['terminal'] else (),
            tuple(contact['center'])+(contact['innerHeight'],contact['outerHeight']) if contact else None)


def recover_edge_seams(variant, rows, vertices, triangles, labels):
    """Every recovery has a two-vertex seam path to an existing supported wind field."""
    n = len(rows)
    pending = np.array([bool(row.get('review')) for row in rows])
    if not pending.any():
        return []
    face_islands = labels[triangles[:,0]]
    counts = np.bincount(face_islands,minlength=n)
    lo = np.full((n,3),np.inf);hi = np.full((n,3),-np.inf)
    np.minimum.at(lo,labels,vertices);np.maximum.at(hi,labels,vertices)
    span = np.linalg.norm(hi-lo,axis=1)
    height = float(np.ptp(vertices[:,2]))
    tolerance = float(np.clip(.0005*height,.005,.03))
    candidate = pending & (counts>0) & (counts<=64) & (span<=min(2.,max(.65,.02*height)))
    if not candidate.any():
        return []
    fixed = np.full(n,-1,dtype=np.int32)
    keys={};parents=[];areas=[];trusted=[]
    for row in rows:
        i=row['island']
        if row.get('review') or not row.get('influence',True) or not counts[i]:
            continue
        key=wind_field(row)
        owner=keys.get(key)
        if owner is None:
            owner=len(parents);keys[key]=owner;parents.append(row);areas.append(0);trusted.append(False)
        fixed[i]=owner;areas[owner]+=int(counts[i])
        trusted[owner] |= row.get('attachMethod') in ('support','surfaceContact','tipCluster','clusterBranch')
    if not parents:
        return []
    marker = np.array([fixed[i]>=0 and areas[fixed[i]]>=4 and trusted[fixed[i]] and
                      rows[i].get('attachMethod')!='surfaceInherited' for i in range(n)])
    allowed = candidate | (fixed>=0)
    indices=np.flatnonzero(allowed[labels])
    pairs=cKDTree(vertices[indices]).query_pairs(tolerance,output_type='ndarray')
    if not len(pairs):
        return []
    pairs=indices[pairs]
    pairs=pairs[labels[pairs[:,0]]!=labels[pairs[:,1]]]
    if not len(pairs):
        return []
    swap=labels[pairs[:,0]]>labels[pairs[:,1]]
    pairs[swap]=pairs[swap,::-1]
    codes=labels[pairs[:,0]].astype(np.int64)*n+labels[pairs[:,1]]
    unique, inverse=np.unique(codes,return_inverse=True)
    first=np.unique(np.column_stack((inverse,pairs[:,0])),axis=0)
    second=np.unique(np.column_stack((inverse,pairs[:,1])),axis=0)
    first_count=np.bincount(first[:,0],minlength=len(unique))
    second_count=np.bincount(second[:,0],minlength=len(unique))
    # One accidental point crossing is not a seam. Both tissues need two distinct witnesses.
    valid=(first_count>=2)&(second_count>=2)
    gap=np.full(len(unique),np.inf)
    np.minimum.at(gap,inverse,np.linalg.norm(vertices[pairs[:,0]]-vertices[pairs[:,1]],axis=1))
    edges=np.column_stack((unique//n,unique%n))[valid];gap=gap[valid]
    if not len(edges):
        return []
    normal=np.cross(vertices[triangles[:,1]]-vertices[triangles[:,0]],vertices[triangles[:,2]]-vertices[triangles[:,0]])
    summed=np.column_stack([np.bincount(face_islands,weights=normal[:,k],minlength=n) for k in range(3)])
    norm=np.linalg.norm(summed,axis=1)
    surface_area=np.bincount(face_islands,weights=np.linalg.norm(normal,axis=1),minlength=n)
    coherent=norm/np.maximum(surface_area,1e-15)>.7
    summed/=np.maximum(norm,1e-15)[:,None]
    a,b=edges.T
    aligned=(~coherent[a])|(~coherent[b])|(np.abs(np.einsum('ij,ij->i',summed[a],summed[b]))>=.94)
    edges=edges[aligned];gap=gap[aligned]
    if not len(edges):
        return []
    a,b=edges.T
    cost=gap+.25*(np.where(marker[a],0.,span[a])+np.where(marker[b],0.,span[b]))
    cost=np.maximum(cost,tolerance*.25)
    graph=coo_matrix((np.r_[cost,cost],(np.r_[a,b],np.r_[b,a])),shape=(n,n)).tocsr()
    graph.sort_indices()
    distance=np.full((n,2),np.inf)
    owner=np.full((n,2),-1,dtype=np.int32)
    predecessor=np.full((n,2),-1,dtype=np.int32)
    limits=[]
    size=np.ptp(vertices,axis=0)
    for row in parents:
        if row['terminal']:
            extent=float(np.linalg.norm(size*(np.array(row['blade'][1])-row['blade'][0])))
            limit=max(4*tolerance,min(2.,.5*extent))
        else:
            axis=variant['secondaryAxes'][row['secondary']] if row['secondary']>=0 else variant['primaryAxes'][row['primary']]
            extent=float(np.linalg.norm(size*(np.array(axis['tip'])-axis['base'])))
            limit=max(4*tolerance,min(40.,.5*height,extent))
        limits.append(limit)
    queue=[]
    for i in np.flatnonzero(marker & (np.diff(graph.indptr)>0)):
        distance[i,0]=0.;owner[i,0]=fixed[i];heapq.heappush(queue,(0.,int(i),int(fixed[i])))
    def offer(i,field,dist,parent):
        if dist>limits[field] or (fixed[i]>=0 and fixed[i]!=field):
            return
        same=np.flatnonzero(owner[i]==field)
        if len(same):
            slot=int(same[0])
            if dist>=distance[i,slot]:return
        elif dist<distance[i,0]:
            distance[i,1]=distance[i,0];owner[i,1]=owner[i,0];predecessor[i,1]=predecessor[i,0];slot=0
        elif dist<distance[i,1]:slot=1
        else:return
        distance[i,slot]=dist;owner[i,slot]=field;predecessor[i,slot]=parent
        if distance[i,1]<distance[i,0]:
            distance[i]=distance[i,::-1];owner[i]=owner[i,::-1];predecessor[i]=predecessor[i,::-1]
        heapq.heappush(queue,(dist,int(i),int(field)))
    while queue:
        dist,i,field=heapq.heappop(queue)
        if not np.any((owner[i]==field)&(distance[i]==dist)):continue
        for pos in range(graph.indptr[i],graph.indptr[i+1]):
            offer(int(graph.indices[pos]),field,dist+float(graph.data[pos]),i)
    margin=np.zeros(n)
    np.subtract(distance[:,1],distance[:,0],out=margin,where=np.isfinite(distance[:,0]))
    eligible=candidate & np.isfinite(distance[:,0]) & (margin>=np.maximum(2*tolerance,.1*distance[:,0]))
    # A new binding must not create a discontinuity against an already bound neighbor.
    for left,right in edges:
        if candidate[left] and fixed[right]>=0 and owner[left,0]!=fixed[right]:eligible[left]=False
        if candidate[right] and fixed[left]>=0 and owner[right,0]!=fixed[left]:eligible[right]=False
        if candidate[left] and candidate[right] and owner[left,0]!=owner[right,0]:
            eligible[left]=False;eligible[right]=False
    reached=marker.copy()
    recovered=[]
    for i in np.argsort(distance[:,0],kind='stable'):
        if not np.isfinite(distance[i,0]):break
        if marker[i]:continue
        parent=predecessor[i,0]
        if parent<0 or not reached[parent] or owner[parent,0]!=owner[i,0]:continue
        if fixed[i]>=0:
            reached[i]=True;continue
        if not eligible[i]:continue
        field=int(owner[i,0]);donor=parents[field]
        inherit_surface(rows[i],donor)
        reached[i]=True
        recovered.append(dict(island=int(i),sourceIsland=int(donor['island']),seamParentIsland=int(parent),
            distanceCm=float(distance[i,0]),competingDistanceCm=float(distance[i,1]) if np.isfinite(distance[i,1]) else None,
            toleranceCm=tolerance))
    return recovered
