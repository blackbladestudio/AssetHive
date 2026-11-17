import unittest
import numpy as np
from windlayer.continuation_review import capped_shaft, recover_capped_stems
from windlayer.contact_review import recover_contacts


def tube(base, tip, radius=.1, flat=1.):
    base, tip = np.array(base), np.array(tip)
    direction = tip-base
    direction = direction/np.linalg.norm(direction)
    side = np.cross(direction, [0.,1.,0.]);side /= np.linalg.norm(side)
    up = np.cross(direction, side)
    points=[];faces=[]
    for k in range(7):
        center = base+(tip-base)*k/6
        points.extend(center+radius*(np.cos(a)*side+flat*np.sin(a)*up) for a in np.arange(8)*np.pi/4)
        if k:
            for j in range(8):
                a=(k-1)*8+j;b=(k-1)*8+(j+1)%8;c=k*8+j;d=k*8+(j+1)%8
                faces.extend(([a,b,c],[b,d,c]))
    # One capped end, one open root: this is not the two-rim case.
    for j in range(1,7):faces.append([48,48+j,48+j+1])
    return np.array(points),np.array(faces)


class CappedStems(unittest.TestCase):
    def test_closed_sections_accept_capped_stems_and_reject_solid_flat_leaves(self):
        for flat in (1.,.01):
            p,f=tube([0.,0.,0.],[0.,0.,10.],flat=flat)
            self.assertEqual(capped_shaft(p,f) is not None,flat==1.)

    def test_continuation_reuses_parent_instead_of_inventing_a_third_axis(self):
        first,faces1=tube([0.,0.,0.],[0.,0.,6.],radius=.12)
        later,faces2=tube([0.,0.,5.],[0.,0.,10.],radius=.12)
        p=np.vstack([first,later]);f=np.vstack([faces1,faces2+len(first)]);labels=np.repeat([0,1],[len(first),len(later)])
        low=p.min(0);size=np.maximum(np.ptp(p,axis=0),1e-9);norm=lambda q:((np.array(q)-low)/size).tolist()
        v=dict(primaryAxes=[dict(id=0,base=norm([0,0,0]),tip=norm([0,0,6]))],secondaryAxes=[dict(id=0,primary=0,base=norm([0,0,0]),tip=norm([0,0,6]),attachOnPrimary=.25)])
        rows=[dict(island=0,primary=0,secondary=0,primaryAttachment=.25,secondaryAttachment=-1.,attachMethod='support',terminal=False),dict(island=1,review=True,influence=False,attachMethod='unplacedSupport')]
        changed=recover_capped_stems(v,rows,p,f,labels,'herb')
        self.assertEqual(len(changed),1)
        self.assertTrue(changed[0]['continuation'])
        self.assertEqual(len(v['secondaryAxes']),1)
        self.assertEqual((rows[1]['primaryAttachment'],rows[1]['secondaryAttachment']),(.25,-1.))

    def test_small_leaf_uses_its_own_contact_scale(self):
        stem=np.array([[-.05,0.,0.],[.05,0.,0.],[-.05,0.,100.],[.05,0.,100.]])
        leaf=np.array([[-.01,.002,60.],[.01,.002,60.],[-.03,.25,60.],[.03,.25,60.],[0.,.5,60.]])
        p=np.vstack([stem,leaf]);f=np.array([[0,1,2],[1,3,2],[4,5,6],[5,7,6],[6,7,8]]);labels=np.repeat([0,1],[4,5])
        v=dict(primaryAxes=[dict(id=0,base=[.5,0.,0.],tip=[.5,0.,1.],synthetic=False)],secondaryAxes=[])
        rows=[dict(island=0,primary=0,secondary=-1,primaryAttachment=-1.,attachMethod='support',terminal=False),dict(island=1,unit=1,review=True,influence=False,terminal=False,attachMethod='synthetic')]
        recover_contacts(v,rows,p,f,labels,'herb',detail_contacts=True)
        self.assertFalse(rows[1]['review'])
        self.assertAlmostEqual(rows[1]['primaryAttachment'],.6)
        self.assertTrue(rows[1]['terminal'])


if __name__=='__main__':unittest.main()
