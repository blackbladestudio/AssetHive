import unittest
import numpy as np
from windlayer.cluster_review import complete_organ,recover_organ_clusters
from windlayer.seam_review import recover_edge_seams
from test_continuation_review import tube


OCT_FACES=np.array([[4,0,1],[4,1,2],[4,2,3],[4,3,0],[5,1,0],[5,2,1],[5,3,2],[5,0,3]])


class ClusterAndSeamReview(unittest.TestCase):
    def clustered(self,competing=False):
        octa=np.array([[1.,0.,0.],[0.,1.,0.],[-1.,0.,0.],[0.,-1.,0.],[0.,0.,1.],[0.,0.,-1.]])*.08
        p=[np.array([[0.,0.,0.],[0.,0.,100.]])];faces=[];labels=[0,1]
        rows=[dict(island=i,influence=False,review=False,terminal=False,attachMethod='noSurface') for i in (0,1)]
        for k,x in enumerate((0.,.15,.30,.45,.60)):
            i=k+2;faces.append(OCT_FACES+2+k*6);p.append(octa+[x,0.,80.]);labels.extend([i]*6)
            if k<3:
                rows.append(dict(island=i,primary=int(competing and k==0),secondary=-1,primaryAttachment=.8,secondaryAttachment=-1.,
                    terminal=True,layers=['Shared','Branch1','Ripple'],blade=[[0.,0.,.79],[0.,0.,.81]],attachMethod='tipCluster'))
            else:rows.append(dict(island=i,review=True,influence=False,terminal=False,layers=['Shared'],attachMethod='synthetic'))
        axes=[dict(id=i,base=[0.,0.,0.],tip=[0.,0.,1.]) for i in range(2)]
        return dict(primaryAxes=axes,secondaryAxes=[]),rows,np.vstack(p),np.vstack(faces),np.array(labels)

    def test_complete_organ_excludes_a_closed_flat_leaf(self):
        octa=np.array([[1.,0.,0.],[0.,1.,0.],[-1.,0.,0.],[0.,-1.,0.],[0.,0.,1.],[0.,0.,-1.]])
        self.assertTrue(complete_organ(octa,OCT_FACES))
        octa[:,1]*=.001
        self.assertFalse(complete_organ(octa,OCT_FACES))

    def test_three_original_witnesses_recover_branch_levels_without_inventing_ripple(self):
        args=self.clustered()
        proof=recover_organ_clusters(*args)
        self.assertEqual(len(proof),2)
        for p in proof:self.assertGreaterEqual(len(p['originalWitnesses']),3)
        for row in args[1][-2:]:
            self.assertFalse(row['review'])
            self.assertFalse(row['terminal'])
            self.assertEqual(row['layers'],['Shared','Branch1'])
            self.assertEqual(row['primaryAttachment'],.8)

    def test_competing_original_branch_prevents_cluster_propagation(self):
        args=self.clustered(competing=True)
        self.assertEqual(recover_organ_clusters(*args),[])
        self.assertTrue(all(row['review'] for row in args[1][-2:]))

    def test_another_variant_reuses_shape_but_locates_its_own_stem(self):
        bank={};first=self.clustered()
        recover_organ_clusters(*first,template_bank=bank,variant_name='VarA')
        shaft,faces=tube([0.,0.,70.],[0.,0.,90.])
        bud=np.array([[1.,0.,0.],[0.,1.,0.],[-1.,0.,0.],[0.,-1.,0.],[0.,0.,1.],[0.,0.,-1.]])*.08+[.155,0.,85.]
        p=np.vstack([[[0.,0.,0.],[0.,0.,100.]],shaft,bud])
        f=np.vstack([faces+2,OCT_FACES+2+len(shaft)])
        labels=np.r_[0,1,np.repeat(2,len(shaft)),np.repeat(3,len(bud))]
        low=p.min(0);size=np.maximum(np.ptp(p,axis=0),1e-9);norm=lambda point:((np.array(point)-low)/size).tolist()
        v=dict(primaryAxes=[dict(id=0,base=norm([0,0,0]),tip=norm([0,0,100]))],secondaryAxes=[],frame=dict(bboxMinCm=low.tolist(),sizeCm=size.tolist()))
        rows=[dict(island=i,influence=False,review=False,terminal=False,attachMethod='noSurface') for i in (0,1)]
        rows.extend([dict(island=2,primary=0,secondary=-1,primaryAttachment=-1.,secondaryAttachment=-1.,terminal=False,
            layers=['Shared','Branch1'],blade=[norm([0,0,70]),norm([0,0,90])],attachMethod='support'),
            dict(island=3,review=True,influence=False,terminal=False,layers=['Shared'],attachMethod='synthetic')])
        proof=recover_organ_clusters(v,rows,p,f,labels,template_bank=bank,variant_name='VarB')
        self.assertEqual(len(proof),1)
        self.assertEqual(proof[0]['templateVariant'],'VarA')
        self.assertEqual(len(proof[0]['stemContactWitnessVertices']),3)
        self.assertEqual(rows[3]['primaryAttachment'],-1.)
        self.assertFalse(rows[3]['terminal'])

    def seam(self,competing=False):
        vertices=[np.array([[0.,0.,0.],[0.,0.,100.]])];labels=[0,1];triangles=[]
        rows=[dict(island=i,influence=False,review=False,terminal=False,attachMethod='noSurface') for i in (0,1)]
        for k,(lo,hi) in enumerate(((0.,1.),(1.005,1.205),(1.210,1.410))+(((1.415,2.415),) if competing else ())):
            i=k+2;offset=sum(len(v) for v in vertices)
            points=np.array([[lo,0.,10.],[hi,0.,10.],[hi,1.,10.],[lo,1.,10.],[(lo+hi)*.5,.5,10.]])
            vertices.append(points);labels.extend([i]*5)
            triangles.append(np.array([[0,1,4],[1,2,4],[2,3,4],[3,0,4]])+offset)
            if k in (0,3):
                rows.append(dict(island=i,primary=int(k==3),secondary=-1,primaryAttachment=-1.,secondaryAttachment=-1.,terminal=False,
                    layers=['Shared','Branch1'],blade=[[0.,0.,0.],[0.,0.,1.]],attachMethod='support'))
            else:rows.append(dict(island=i,review=True,influence=False,terminal=False,layers=['Shared'],attachMethod='synthetic'))
        axes=[dict(id=i,base=[0.,0.,0.],tip=[0.,0.,1.]) for i in range(2)]
        return dict(primaryAxes=axes,secondaryAxes=[]),rows,np.vstack(vertices),np.vstack(triangles),np.array(labels)

    def test_two_vertex_seams_recover_a_continuous_path(self):
        args=self.seam()
        proof=recover_edge_seams(*args)
        self.assertEqual([p['island'] for p in proof],[3,4])
        self.assertEqual(proof[1]['seamParentIsland'],3)

    def test_wind_field_frontiers_do_not_join_different_branches(self):
        args=self.seam(competing=True)
        self.assertEqual(recover_edge_seams(*args),[])


if __name__=='__main__':unittest.main()
